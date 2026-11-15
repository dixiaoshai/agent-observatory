import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { ensureCollectionSchema, acquireCollectionLease, releaseCollectionLease, sourceKey } from '../src/collector.ts';
import { Archive } from '../src/store.ts';
import type { Event } from '../src/types.ts';
import { loadConfig, temporaryDirectory, writeServiceConfig } from './support.ts';

const CREATED = Date.parse('2026-01-01T10:00:00.000Z');
const at = (second: number): number => CREATED + second * 1000;

/** A dsh session whose display name is revised by two `session/title` records. */
function dshRows(withTitles: boolean, cwd: string): unknown[] {
  const rows = [
    {
      type: 'session', version: 4, id: 'session-reingest', createdAt: CREATED,
      cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
    },
    { type: 'turn/start', seq: 1, time: at(1), data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: at(1),
      data: { content: [{ type: 'text', text: 'First prompt' }], role: 'user', source: { kind: 'user' } },
    },
    { type: 'session/title', seq: 3, time: at(2), data: { title: 'Prompt title' } },
    {
      type: 'assistant/message', seq: 4, time: at(3),
      data: {
        turn: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Answer' }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    },
    { type: 'session/title', seq: 5, time: at(4), data: { title: 'Model title' } },
    { type: 'turn/end', seq: 6, time: at(5), data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  return withTitles ? rows : rows.filter(row => (row as { type: string }).type !== 'session/title');
}

function encodeRows(rows: unknown[]): Buffer {
  const header = zstdCompressSync(`${JSON.stringify(rows[0])}\n`);
  const events = zstdCompressSync(rows.slice(1).map(row => JSON.stringify(row)).join('\n') + '\n');
  return Buffer.concat([header, events]);
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve('src/cli.ts'), ...args], {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function titles(events: Event[]): string[] {
  return events.filter(event => event.kind === 'session.title').map(event => String(event.data.title));
}

test('reingest refreshes normalized metadata for already imported files', async t => {
  const dir = temporaryDirectory(t, 'agent-trace-reingest-');
  const project = path.join(dir, 'project');
  const logs = path.join(dir, 'logs');
  const sessionDir = path.join(logs, '--project--', 'session-reingest');
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const filename = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const configFile = writeServiceConfig(dir, {
    database: 'state/trace.sqlite',
    captureMode: 'metadata',
    collection: {
      enabled: false,
      scan_interval_seconds: 30,
      backfill: 'all',
      sources: [{
        instance_id: 'reingest-device',
        runtime: 'dsh',
        root: 'logs',
        projects: [{ project_id: 'demo', cwd_allowlist: ['project'] }],
      }],
    },
    api: { enabled: false },
  });
  const config = loadConfig(configFile);
  const source = config.collection.sources[0]!;

  // Simulate an archive created before the title adapter existed: no title events.
  writeFileSync(filename, encodeRows(dshRows(false, project)));
  const before = new Archive(config.database, config.capture_mode, config.content);
  try {
    assert.equal(before.importFile(filename, source.instance_id, 'demo').imported, 6);
    assert.deepEqual(titles(before.exportBatch(0, 100, 'metadata').events), []);
    // The collector has already recorded this file as imported.
    ensureCollectionSchema(before.db);
    const stat = statSync(filename);
    before.db.prepare(`INSERT INTO collection_files
      (source_key,file_id,path,size,mtime_ms,ctime_ms,outcome,pending,scope_hash,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(sourceKey(source), `${stat.dev}:${stat.ino}`, filename, stat.size,
        Math.trunc(stat.mtimeMs), Math.trunc(stat.ctimeMs), 'imported', 0, 'scope', new Date().toISOString());
  } finally {
    before.close();
  }

  // The source file now carries the display-name revisions.
  writeFileSync(filename, encodeRows(dshRows(true, project)));
  const first = await runCli(['reingest', '--config', configFile]);
  assert.equal(first.code, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.scanned, 1);
  assert.equal(report.imported, 2);
  assert.equal(report.skipped, 6);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.errors, []);

  const after = new Archive(config.database, config.capture_mode, config.content);
  try {
    assert.deepEqual(titles(after.exportBatch(0, 100, 'metadata').events), ['Prompt title', 'Model title']);
    assert.equal(after.db.prepare('SELECT count(*) AS n FROM collection_lease').get()?.n, 0);
  } finally {
    after.close();
  }

  // Re-running stays idempotent: every event identity already exists.
  const second = await runCli(['reingest', '--config', configFile]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).imported, 0);
  assert.equal(JSON.parse(second.stdout).skipped, 8);

  // Harnesses prune their own logs; an absent tracked source is reported as
  // `missing` and must not fail the reconciliation or skip other files.
  const removedFile = path.join(sessionDir, 'session.v0.jsonl.zstd');
  const track = new Archive(config.database, config.capture_mode, config.content);
  try {
    ensureCollectionSchema(track.db);
    track.db.prepare(`INSERT INTO collection_files
      (source_key,file_id,path,size,mtime_ms,ctime_ms,outcome,pending,scope_hash,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(sourceKey(source), 'gone-file', removedFile, 0, 0, 0, 'imported', 0, 'scope', new Date().toISOString());
  } finally {
    track.close();
  }
  const pruned = await runCli(['reingest', '--config', configFile]);
  assert.equal(pruned.code, 0, pruned.stderr);
  const prunedReport = JSON.parse(pruned.stdout);
  assert.equal(prunedReport.scanned, 2);
  assert.equal(prunedReport.missing, 1);
  assert.deepEqual(prunedReport.errors, []);

  // A live collection lease blocks reingest instead of racing the collector.
  const busy = new Archive(config.database, config.capture_mode, config.content);
  try {
    ensureCollectionSchema(busy.db);
    assert.equal(acquireCollectionLease(busy.db, 'collector-owner').acquired, true);
  } finally {
    busy.close();
  }
  const blocked = await runCli(['reingest', '--config', configFile]);
  assert.equal(blocked.code, 1);
  assert.equal(JSON.parse(blocked.stderr).error.code, 'COLLECTION_BUSY');
  const unblock = new Archive(config.database, config.capture_mode, config.content);
  try {
    assert.equal(releaseCollectionLease(unblock.db, 'collector-owner'), true);
  } finally {
    unblock.close();
  }
});
