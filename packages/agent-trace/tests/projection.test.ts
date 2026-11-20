import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { Archive } from '../src/store.ts';
import { PROJECTION_VERSION } from '../src/projection.ts';
import { TraceService, type ServiceEvent } from '../src/service.ts';
import type { Event } from '../src/types.ts';
import { loadConfig, STATS_TOKEN_HASH, temporaryDirectory, writeServiceConfig, freeLoopbackPort } from './support.ts';

const CREATED = Date.parse('2026-01-01T10:00:00.000Z');
const at = (second: number): number => CREATED + second * 1000;
const cli = path.resolve('src/cli.ts');

function dshRows(cwd: string): unknown[] {
  return [
    {
      type: 'session', version: 4, id: 'session-projection', createdAt: CREATED,
      cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
    },
    { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: at(1),
      data: { content: [{ type: 'text', text: 'Synthetic prompt' }], role: 'user', source: { kind: 'user' } },
    },
    {
      type: 'assistant/message', seq: 3, time: at(2),
      data: {
        turn: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Synthetic answer' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    },
    { type: 'turn/end', seq: 4, time: at(3), data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

function encodeRows(rows: unknown[]): Buffer {
  const header = zstdCompressSync(`${JSON.stringify(rows[0])}\n`);
  const rest = zstdCompressSync(rows.slice(1).map(row => JSON.stringify(row)).join('\n') + '\n');
  return Buffer.concat([header, rest]);
}

/** Rewrite the archive as if an older projection had produced it. */
function downgrade(db: string): void {
  const raw = new DatabaseSync(db);
  try {
    for (const row of raw.prepare('SELECT seq,payload FROM events').all() as Array<{ seq: number; payload: string }>) {
      const event = JSON.parse(row.payload) as Event;
      if (event.kind === 'usage.snapshot') {
        delete event.data.usage_basis;
        delete event.data.request_id;
        delete event.data.request_id_source;
        raw.prepare('UPDATE events SET payload=? WHERE seq=?').run(JSON.stringify(event), row.seq);
      }
    }
    raw.prepare("UPDATE metadata SET value='codex-v1' WHERE key='normalizer_version'").run();
  } finally {
    raw.close();
  }
}

function projectionEvents(archive: Archive): Event[] {
  return archive.exportBatch(0, 100, 'metadata').events.filter(event => event.kind === 'usage.snapshot');
}

test('a new archive records the projection that wrote it', t => {
  const dir = temporaryDirectory(t, 'agent-trace-projection-');
  const archive = new Archive(path.join(dir, 'archive.sqlite'));
  try {
    assert.equal(archive.projectionVersion, PROJECTION_VERSION);
    const status = archive.status();
    assert.equal(status.normalizer_version, PROJECTION_VERSION);
    assert.equal(status.expected_normalizer_version, PROJECTION_VERSION);
    assert.equal(archive.assertProjectionCurrent(), undefined);
  } finally {
    archive.close();
  }
});

test('an archive written by another projection stays readable but refuses new writes', t => {
  const dir = temporaryDirectory(t, 'agent-trace-projection-');
  const source = path.join(dir, 'session.v4.jsonl.zstd');
  const db = path.join(dir, 'archive.sqlite');
  writeFileSync(source, encodeRows(dshRows(dir)));
  const first = new Archive(db);
  try { first.importFile(source, 'local', 'demo'); } finally { first.close(); }
  downgrade(db);

  const legacy = new Archive(db);
  try {
    const status = legacy.status();
    assert.equal(status.normalizer_version, 'codex-v1');
    assert.equal(status.expected_normalizer_version, PROJECTION_VERSION);
    const snapshots = projectionEvents(legacy);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.data.usage_basis, undefined, 'stored projections are not rewritten on open');
    assert.throws(
      () => legacy.importFile(source, 'local', 'demo'),
      (error: Error & { code?: string }) =>
        error.code === 'PROJECTION_MISMATCH' && /Rebuild the archive from its configured sources/.test(error.message),
    );
    assert.throws(
      () => legacy.deleteSession('dsh', 'local', 'session-projection'),
      (error: Error & { code?: string }) => error.code === 'PROJECTION_MISMATCH',
    );
    assert.equal(projectionEvents(legacy).length, 1, 'a refused write keeps the readable projection intact');
  } finally {
    legacy.close();
  }

  // Rebuilding from the same sources into a new database normalizes with the
  // current adapters; that is the supported upgrade path.
  const rebuilt = new Archive(path.join(dir, 'rebuilt.sqlite'));
  try {
    assert.equal(rebuilt.projectionVersion, PROJECTION_VERSION);
    const report = rebuilt.importFile(source, 'local', 'demo');
    assert.equal(report.imported, 6);
    const snapshots = projectionEvents(rebuilt);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.data.usage_basis, 'request');
    assert.match(String(snapshots[0]!.data.request_id), /^seq-\d+$/);
  } finally {
    rebuilt.close();
  }
});

test('an unversioned legacy archive is reported and refused', t => {
  const dir = temporaryDirectory(t, 'agent-trace-projection-');
  const db = path.join(dir, 'archive.sqlite');
  new Archive(db, 'metadata').close();
  const raw = new DatabaseSync(db);
  raw.prepare("DELETE FROM metadata WHERE key='normalizer_version'").run();
  raw.close();

  const legacy = new Archive(db, 'metadata');
  try {
    assert.equal(legacy.status().normalizer_version, null);
    assert.throws(
      () => legacy.deleteSession('codex', 'local', 'session-unversioned'),
      (error: Error & { code?: string }) =>
        error.code === 'PROJECTION_MISMATCH' && /an unversioned archive/.test(error.message),
    );
  } finally {
    legacy.close();
  }
});

test('CLI status reports the projection and write commands fail closed', t => {
  const dir = temporaryDirectory(t, 'agent-trace-projection-');
  const source = path.join(dir, 'session.v4.jsonl.zstd');
  const db = path.join(dir, 'archive.sqlite');
  writeFileSync(source, encodeRows(dshRows(dir)));
  const first = new Archive(db);
  try { first.importFile(source, 'local', 'demo'); } finally { first.close(); }
  downgrade(db);

  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--db', db], { encoding: 'utf8' }));
  assert.equal(status.normalizer_version, 'codex-v1');
  assert.equal(status.expected_normalizer_version, PROJECTION_VERSION);

  const ingest = spawnSync(process.execPath, [cli, 'ingest', '--db', db, '--source', source, '--instance', 'local', '--project', 'demo'], { encoding: 'utf8' });
  assert.equal(ingest.status, 1);
  assert.equal(JSON.parse(ingest.stderr).error.code, 'PROJECTION_MISMATCH');
  assert.match(JSON.parse(ingest.stderr).error.message, /Rebuild the archive/);

  // Reads still work for consumers that can handle the recorded projection.
  const exported = JSON.parse(execFileSync(process.execPath, [cli, 'export', '--db', db, '--limit', '100'], { encoding: 'utf8' }));
  assert.equal(exported.events.length, 6);
});

test('serve refuses to start against an archive from another projection', async t => {
  const dir = temporaryDirectory(t, 'agent-trace-projection-');
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'metadata',
    collection: { enabled: false, sources: [] },
    api: {
      enabled: true,
      host: '127.0.0.1',
      port: await freeLoopbackPort(),
      clients: [{ id: 'agent-stats', views: ['metadata'], token_sha256: STATS_TOKEN_HASH }],
    },
  });
  const config = loadConfig(configFile);
  new Archive(config.database, config.capture_mode).close();
  const raw = new DatabaseSync(config.database);
  raw.prepare("UPDATE metadata SET value='codex-v1' WHERE key='normalizer_version'").run();
  raw.close();

  const events: ServiceEvent[] = [];
  const service = new TraceService(config, { onEvent: event => events.push(event) });
  await assert.rejects(
    service.start(),
    (error: Error & { code?: string }) =>
      error.code === 'PROJECTION_MISMATCH' && /Rebuild the archive from its configured sources/.test(error.message),
  );
  assert.equal(events.filter(event => event.type === 'serve.started').length, 0);
});

test('reingest refuses a different projection instead of appearing to reconcile', t => {
  const dir = temporaryDirectory(t, 'agent-trace-projection-');
  const logs = path.join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  const source = path.join(logs, 'session.v4.jsonl.zstd');
  writeFileSync(source, encodeRows(dshRows(logs)));
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'metadata',
    collection: {
      enabled: false,
      sources: [{
        instance_id: 'local',
        runtime: 'dsh',
        root: 'logs',
        projects: [{ project_id: 'demo', cwd_allowlist: ['logs'] }],
      }],
    },
    api: { enabled: false },
  });
  const config = loadConfig(configFile);
  const first = new Archive(config.database, config.capture_mode);
  try { first.importFile(source, 'local', 'demo'); } finally { first.close(); }
  const raw = new DatabaseSync(config.database);
  raw.prepare("UPDATE metadata SET value='codex-v1' WHERE key='normalizer_version'").run();
  raw.close();

  const reingest = spawnSync(process.execPath, [cli, 'reingest', '--config', configFile], { cwd: dir, encoding: 'utf8' });
  assert.equal(reingest.status, 1);
  assert.equal(JSON.parse(reingest.stderr).error.code, 'PROJECTION_MISMATCH');
});
