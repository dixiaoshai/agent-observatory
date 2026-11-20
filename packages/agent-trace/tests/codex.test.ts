import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalize, parseRecords, type SourceRecord } from '../src/codex.ts';
import { Archive } from '../src/store.ts';
import { hash } from '../src/types.ts';

// Synthetic identity only; the adapter must never copy it into event data.
const SYNTHETIC_ACCOUNT = 'synthetic-account-0001';
const SOURCE = '/synthetic/codex-rollout.jsonl';

function rollout(row: Record<string, unknown>): SourceRecord[] {
  const text = JSON.stringify(row) + '\n';
  return parseRecords(text).records;
}

function sessionMeta(payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: '2026-05-01T00:00:00Z',
    type: 'session_meta',
    payload: { id: 'account-session', cwd: '/synthetic/account', ...payload },
  };
}

function turnEvent(type: string): Record<string, unknown> {
  return { timestamp: '2026-05-01T00:00:01Z', type: 'event_msg', payload: { type, turn_id: 'turn-1' } };
}

function fileRows(rows: Record<string, unknown>[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

test('creator_account_id emits one session.auth immediately after session.started', () => {
  const records = [...rollout(sessionMeta({ creator_account_id: SYNTHETIC_ACCOUNT })), ...rollout(turnEvent('task_started'))];
  const events = normalize(records, SOURCE, 'device-a', 'demo', 'metadata');
  assert.equal(events.length, 3);
  const start = events[0]!;
  const auth = events[1]!;
  assert.equal(start.kind, 'session.started');
  assert.equal(auth.kind, 'session.auth');
  assert.equal(events[2]!.kind, 'turn.started');
  assert.equal(auth.schema_version, 1);
  assert.equal(auth.archive_seq, 0);
  assert.equal(auth.runtime, 'codex');
  assert.equal(auth.instance_id, 'device-a');
  assert.equal(auth.session_id, 'account-session');
  assert.equal(auth.session_key, start.session_key);
  assert.equal(auth.project_id, 'demo');
  assert.equal(auth.occurred_at, '2026-05-01T00:00:00.000Z');
  assert.equal(auth.observed_at, start.observed_at);
  assert.equal(auth.native_type, 'session_meta');
  assert.deepEqual(auth.data, { turn_id: null, root_turn_id: null, model: null, account_scoped: true });
  assert.deepEqual(auth.source, start.source);
  assert.equal(auth.source!.line, 1);
  assert.equal(auth.body, null);
  assert.equal(auth.raw, null);
  // Only the boolean meaning is exposed; the raw id is never copied into data.
  assert.doesNotMatch(JSON.stringify(auth.data), /synthetic-account/);
  assert.match(JSON.stringify(auth), /"account_scoped":true/);
  // session.started keeps its published identity; the shared source line gets a
  // kind discriminator appended after it for session.auth only.
  assert.equal(start.event_id, hash(JSON.stringify(['codex', 'device-a', 'account-session', 1])));
  assert.equal(auth.event_id, hash(JSON.stringify(['codex', 'device-a', 'account-session', 1, 'session.auth'])));
  assert.notEqual(auth.event_id, start.event_id);
});

test('content view keeps session.auth body and raw null and never stores the raw account id', () => {
  const records = [...rollout(sessionMeta({ creator_account_id: SYNTHETIC_ACCOUNT })), ...rollout(turnEvent('task_started'))];
  const events = normalize(records, SOURCE, 'device-a', 'demo', 'content');
  const start = events.find(event => event.kind === 'session.started')!;
  const auth = events.find(event => event.kind === 'session.auth')!;
  assert.equal(events.indexOf(auth), events.indexOf(start) + 1);
  assert.equal(auth.body, null);
  assert.equal(auth.raw, null);
  assert.deepEqual(auth.data, { turn_id: null, root_turn_id: null, model: null, account_scoped: true });
  assert.doesNotMatch(JSON.stringify(auth), /synthetic-account/);
});

test('folded rollouts use the source series in the session.auth discriminator tuple', () => {
  const records = parseRecords(fileRows([
    sessionMeta({ id: 'child-session' }),
    sessionMeta({ id: 'parent-session', creator_account_id: SYNTHETIC_ACCOUNT }),
    turnEvent('task_started'),
  ])).records;
  const events = normalize(records, SOURCE, 'device-a', 'demo', 'metadata');
  assert.equal(events.length, 3);
  const start = events[0]!;
  const auth = events[1]!;
  assert.equal(start.kind, 'session.started');
  assert.equal(auth.kind, 'session.auth');
  assert.equal(events[2]!.kind, 'turn.started');
  assert.equal(auth.session_id, 'parent-session');
  assert.equal(auth.source!.series, 'child-session');
  assert.equal(auth.source!.line, 2);
  assert.equal(start.event_id, hash(JSON.stringify(['codex', 'device-a', 'parent-session', 'child-session', 2])));
  assert.equal(auth.event_id, hash(JSON.stringify(['codex', 'device-a', 'parent-session', 'child-session', 2, 'session.auth'])));
});

test('an earlier non-authoritative session_meta account marker emits no session.auth', () => {
  const records = parseRecords(fileRows([
    sessionMeta({ id: 'child-session', creator_account_id: SYNTHETIC_ACCOUNT }),
    sessionMeta({ id: 'parent-session' }),
    turnEvent('task_started'),
  ])).records;
  const events = normalize(records, SOURCE, 'device-a', 'demo', 'metadata');
  assert.equal(events.filter(event => event.kind === 'session.auth').length, 0);
  assert.equal(events[0]!.kind, 'session.started');
  assert.equal(events[0]!.session_id, 'parent-session');
});

test('missing, empty or non-string creator_account_id emits no session.auth', () => {
  for (const marker of [undefined, '', '   ', 42, null, {}]) {
    const payload = marker === undefined ? {} : { creator_account_id: marker };
    const records = [...rollout(sessionMeta(payload)), ...rollout(turnEvent('task_started'))];
    const events = normalize(records, SOURCE, 'device-a', 'demo', 'metadata');
    assert.equal(events.length, 2, `unexpected events for marker ${JSON.stringify(marker)}`);
    assert.equal(events[0]!.kind, 'session.started');
    assert.equal(events[1]!.kind, 'turn.started');
  }
});

test('duplicate and moved archive imports keep exactly one session.auth', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-codex-'));
  const filename = path.join(dir, 'account-scoped.jsonl');
  writeFileSync(filename, fileRows([
    sessionMeta({ creator_account_id: SYNTHETIC_ACCOUNT }),
    turnEvent('task_started'),
    turnEvent('task_complete'),
  ]));
  const archive = new Archive(path.join(dir, 'archive.sqlite'), 'content');
  t.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });

  const first = archive.importFile(filename, 'local', 'demo');
  assert.equal(first.imported, 4);
  const second = archive.importFile(filename, 'local', 'demo');
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 4);
  const moved = path.join(dir, 'moved.jsonl');
  copyFileSync(filename, moved);
  assert.equal(archive.importFile(moved, 'local', 'demo').imported, 0);

  const events = archive.exportBatch(0, 100, 'metadata').events;
  assert.equal(events.length, 4);
  const authEvents = events.filter(event => event.kind === 'session.auth');
  assert.equal(authEvents.length, 1);
  const start = events.find(event => event.kind === 'session.started')!;
  assert.equal(events.indexOf(authEvents[0]!), events.indexOf(start) + 1);
  assert.equal(authEvents[0]!.event_id, hash(JSON.stringify(['codex', 'local', 'account-session', 1, 'session.auth'])));
  assert.doesNotMatch(JSON.stringify(authEvents[0]!.data), /synthetic-account/);

  // Both views expose the same boolean signal, but content mode still keeps the
  // session.auth body/raw null because the kind carries no captured body.
  const contentAuth = archive.exportBatch(0, 100, 'content').events.find(event => event.kind === 'session.auth')!;
  assert.equal(contentAuth.body, null);
  assert.equal(contentAuth.raw, null);
  assert.deepEqual(contentAuth.data, { turn_id: null, root_turn_id: null, model: null, account_scoped: true });
});

test('an archive that predates the kind backfills session.auth without changing other identities', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-codex-'));
  const filename = path.join(dir, 'account-scoped.jsonl');
  writeFileSync(filename, fileRows([
    sessionMeta({ creator_account_id: SYNTHETIC_ACCOUNT }),
    turnEvent('task_started'),
  ]));
  const archive = new Archive(path.join(dir, 'archive.sqlite'), 'metadata');
  t.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });
  archive.importFile(filename, 'local', 'demo');
  const before = archive.exportBatch(0, 100, 'metadata').events;
  const startId = before.find(event => event.kind === 'session.started')!.event_id;
  const turnId = before.find(event => event.kind === 'turn.started')!.event_id;
  // Simulate an archive written before this kind existed: the projection version
  // is unchanged (the kind is additive), so only the derived event is missing.
  const authId = hash(JSON.stringify(['codex', 'local', 'account-session', 1, 'session.auth']));
  archive.db.prepare('DELETE FROM events WHERE event_id=?').run(authId);
  assert.equal(archive.exportBatch(0, 100, 'metadata').events.filter(event => event.kind === 'session.auth').length, 0);

  const reconciled = archive.importFile(filename, 'local', 'demo');
  assert.equal(reconciled.imported, 1);
  assert.equal(reconciled.skipped, 2);
  const after = archive.exportBatch(0, 100, 'metadata').events;
  assert.equal(after.filter(event => event.kind === 'session.auth').length, 1);
  assert.ok(after.some(event => event.event_id === startId));
  assert.ok(after.some(event => event.event_id === turnId));
});
