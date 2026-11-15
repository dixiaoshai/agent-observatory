import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { ArchiveEvidenceStore } from '../src/archive/index.js';
import { AgentKnowledgeError } from '../src/core/index.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function event(seq: number, text: string, project = 'demo', session = 'session') {
  return { schema_version: 1, event_id: hash(JSON.stringify(['codex', 'local', session, seq])), archive_seq: seq,
    runtime: 'codex', instance_id: 'local', session_id: session, session_key: JSON.stringify(['codex', 'local', session]), project_id: project,
    kind: 'message.user', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-01T00:00:00Z', native_type: 'event_msg.user_message',
    source: { path: '/gone/session.jsonl', line: seq, record_hash: hash(text) },
    data: { turn_id: null, root_turn_id: null, model: null, title: text }, body: { text }, raw: { type: 'event_msg', payload: { type: 'user_message', message: text } } };
}
function deletion(seq: number, project = 'demo', session = 'session') {
  return { ...event(seq, '', project, session), event_id: hash(JSON.stringify(['codex', 'local', session, 'deleted'])),
    kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
}
function batch(start: number, end: number, events: unknown[]) {
  return { schema_version: 1, archive_id: 'archive-a', view: 'content', after_cursor: start, next_cursor: end, has_more: false, events };
}

test('import, independently scoped search/read and replay survive source removal', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const first = batch(0, 1, [event(1, 'hello world')]);
  assert.equal(store.importBatch(first).imported, 1);
  assert.equal(store.importBatch(first).replayed, true);
  const hit = store.search('world')[0]!;
  assert.equal(hit.event.body?.text, 'hello world');
  assert.equal(store.read('archive-a', hit.event.event_id).event.source?.path, '/gone/session.jsonl');
  assert.throws(() => store.search('world', 'private'));
  assert.throws(() => store.read('archive-a', hit.event.event_id, 'private'));
  store.close();
});

test('out-of-scope projects are skipped as a consumption scope, never rejected', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-knowledge-archive-'));
  const database = path.join(dir, 'evidence.sqlite');
  const store = new ArchiveEvidenceStore(database, 'owner', ['demo']);
  try {
    // One page from a wider archive (e.g. full collection) interleaves projects:
    // in-scope evidence, an out-of-scope message and an out-of-scope deletion.
    const mixed = batch(0, 4, [
      event(1, 'kept one'),
      event(2, 'unscoped message', 'unscoped', 'live'),
      event(3, 'kept two'),
      deletion(4, 'unscoped', 'live'),
    ]);
    const first = store.importBatch(mixed);
    assert.deepEqual(first, { archive_id: 'archive-a', cursor: 4, imported: 2, replayed: false });
    assert.equal(store.search('kept one').length, 1);
    assert.equal(store.search('kept two').length, 1);
    assert.equal(store.committedCursor('archive-a'), 4);
    // The page fingerprint covers the complete batch, so a full replay stays idempotent.
    assert.deepEqual(store.importBatch(mixed), { archive_id: 'archive-a', cursor: 4, imported: 0, replayed: true });

    // A page made only of out-of-scope events still commits and advances the cursor.
    const foreignOnly = batch(4, 6, [event(5, 'another project', 'unscoped', 'live')]);
    assert.deepEqual(store.importBatch(foreignOnly), { archive_id: 'archive-a', cursor: 6, imported: 0, replayed: false });
    assert.deepEqual(store.importBatch(foreignOnly), { archive_id: 'archive-a', cursor: 6, imported: 0, replayed: true });

    // The skipped out-of-scope deletion wrote no tombstone and the skipped event
    // wrote no row: replaying that identity inside the scope is accepted.
    const lateInScope = { ...event(2, 'now in scope', 'demo', 'live'), archive_seq: 8 };
    assert.equal(store.importBatch(batch(6, 8, [lateInScope])).imported, 1);
    assert.equal(store.search('now in scope').length, 1);

    // Explicit queries for an out-of-scope project keep the FORBIDDEN contract.
    assert.throws(() => store.search('kept one', 'unscoped'), (error: AgentKnowledgeError) => error.code === 'FORBIDDEN');
    assert.throws(() => store.read('archive-a', lateInScope.event_id, 'unscoped'), (error: AgentKnowledgeError) => error.code === 'FORBIDDEN');

    // Inspect the projection directly: only in-scope events are persisted, and
    // no tombstone came from the out-of-scope deletion.
    const db = new DatabaseSync(database);
    try {
      const rows = db.prepare('SELECT seq,project_id FROM archive_evidence_events ORDER BY seq').all();
      assert.deepEqual(rows.map(row => [Number(row.seq), String(row.project_id)]), [[1, 'demo'], [3, 'demo'], [8, 'demo']]);
      assert.equal(Number(db.prepare('SELECT count(*) AS n FROM archive_evidence_deleted').get()!.n), 0);
      assert.equal(Number(db.prepare('SELECT cursor FROM archive_evidence_cursors WHERE archive_id=?').get('archive-a')!.cursor), 8);
    } finally { db.close(); }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gaps, conflicting replay and metadata injection roll back', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  store.importBatch(batch(0, 1, [event(1, 'first')]));
  assert.throws(() => store.importBatch(batch(0, 1, [event(1, 'changed')])));
  assert.throws(() => store.importBatch(batch(2, 3, [event(3, 'gap')])));
  const injected = event(2, 'secret'); Object.assign(injected.data, { secret: 'password' });
  assert.throws(() => store.importBatch(batch(1, 2, [injected])));
  assert.equal(store.importBatch(batch(1, 2, [event(2, 'valid')])).cursor, 2);
  assert.equal(store.search('secret').length, 0);
  store.close();
});

test('deletion removes searchable evidence and prevents reimport', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const original = event(1, 'delete me');
  store.importBatch(batch(0, 1, [original]));
  const tombstone = { ...event(2, ''), event_id: hash(JSON.stringify(['codex', 'local', 'session', 'deleted'])), kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  store.importBatch(batch(1, 2, [tombstone]));
  assert.equal(store.search('delete me').length, 0);
  assert.throws(() => store.read('archive-a', original.event_id));
  assert.throws(() => store.importBatch(batch(2, 3, [event(3, 'resurrection')])));
  store.close();
});

test('rejects stalled pages, timezone-free timestamps and mismatched content atomically', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  assert.throws(() => store.importBatch({ ...batch(0, 0, []), has_more: true }));
  const time = event(1, 'clock'); time.occurred_at = '2026-01-01T00:00:00';
  assert.throws(() => store.importBatch(batch(0, 1, [time])));
  const mismatch = event(1, 'original'); mismatch.body.text = 'modified';
  assert.throws(() => store.importBatch(batch(0, 1, [mismatch])));
  assert.equal(store.importBatch(batch(0, 1, [event(1, 'valid')])).cursor, 1);
  store.close();
});

test('an authorized tombstone cannot remove a different project session', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo', 'other']);
  store.importBatch(batch(0, 1, [event(1, 'preserve')]));
  const tombstone = { ...event(2, '', 'other'), event_id: hash(JSON.stringify(['codex', 'local', 'session', 'deleted'])), kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  assert.throws(() => store.importBatch(batch(1, 2, [tombstone])));
  assert.equal(store.search('preserve', 'demo').length, 1);
  store.close();
});

test('deletion cannot reuse an ordinary event ID or repeat under a new sequence', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const original = event(1, 'preserved until valid deletion');
  store.importBatch(batch(0, 1, [original]));
  const bad = { ...event(2, ''), event_id: original.event_id, kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  assert.throws(() => store.importBatch(batch(1, 2, [bad])), /deletion event ID/);
  assert.equal(store.search('preserved').length, 1);
  const good = { ...bad, event_id: hash(JSON.stringify(['codex', 'local', 'session', 'deleted'])) };
  assert.equal(store.importBatch(batch(1, 2, [good])).cursor, 2);
  assert.throws(() => store.importBatch(batch(2, 3, [{ ...good, archive_seq: 3 }])), /Duplicate deletion/);
  assert.equal(store.importBatch(batch(1, 2, [good])).cursor, 2);
  store.close();
});


test('pi content events accept native entries and recorded cost', () => {
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  const piHash = (seq: number, kind: string) => hash(JSON.stringify(['pi', 'local', 'pi-session', kind, seq]));
  const start = {
    schema_version: 1, event_id: piHash(1, 'session.started'), archive_seq: 1,
    runtime: 'pi', instance_id: 'local', session_id: 'pi-session', session_key: '["pi","local","pi-session"]',
    project_id: 'demo', kind: 'session.started', occurred_at: '2026-01-01T00:00:00Z',
    observed_at: '2026-01-01T00:00:00Z', native_type: 'session',
    source: { path: '/gone/pi.jsonl', line: 1, record_hash: hash('pi-start') },
    data: { turn_id: null, root_turn_id: null, model: null, cwd: '/demo', created_at: '2026-01-01T00:00:00Z', title: 'Pi session' },
    body: null, raw: { type: 'session', version: 3, id: 'pi-session', cwd: '/demo' },
  };
  const usage = {
    schema_version: 1, event_id: piHash(4, 'usage.snapshot'), archive_seq: 2,
    runtime: 'pi', instance_id: 'local', session_id: 'pi-session', session_key: '["pi","local","pi-session"]',
    project_id: 'demo', kind: 'usage.snapshot', occurred_at: '2026-01-01T00:00:01Z',
    observed_at: '2026-01-01T00:00:01Z', native_type: 'message.assistant',
    source: { path: '/gone/pi.jsonl', line: 4, record_hash: hash('pi-usage') },
    data: { turn_id: 'u1', root_turn_id: null, model: 'deepseek-flash', cumulative: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
      last_usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 }, rate_limit_only: false, cost_usd: 0.001, cost_source: 'model_rates' },
    body: null, raw: { type: 'message', id: 'a1', message: { role: 'assistant', content: [] } },
  };
  assert.equal(store.importBatch(batch(0, 2, [start, usage])).imported, 2);
  const hit = store.read('archive-a', usage.event_id).event;
  assert.equal(hit.data.cost_usd, 0.001);
  const bad = { ...usage, event_id: piHash(5, 'bad'), archive_seq: 3, data: { ...usage.data, cost_usd: -1 } };
  assert.throws(() => store.importBatch(batch(2, 3, [bad])));
  const badSource = { ...usage, event_id: piHash(6, 'bad-source'), archive_seq: 3, data: { ...usage.data, cost_source: 'invoice' } };
  assert.throws(() => store.importBatch(batch(2, 3, [badSource])));
  store.close();
});

test('externalized content references are accepted, verifiable and still scoped', () => {
  const ref = { content_ref: { path: '/private/blobs/abc.txt', bytes: 1234, sha256: hash('external body'), media_type: 'text/plain' } };
  const returned = { ...event(1, 'ignored'), kind: 'tool.returned', native_type: 'response_item.function_call_output',
    data: { turn_id: null, root_turn_id: null, model: null, call_id: 'call-1', output_bytes: 4147, status: 'result_observed' },
    body: { output: ref }, raw: { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: ref } } };
  const store = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
  store.importBatch(batch(0, 2, [returned, event(2, 'inline message')]));
  const hit = store.search('blobs')[0]!;
  assert.deepEqual(hit.event.body?.output, ref);
  assert.deepEqual(store.read('archive-a', returned.event_id).event.body?.output, ref);
  assert.throws(() => store.search('blobs', 'other'));
  store.close();

  // A reference must be complete and match raw; truncation or a bogus hash is rejected.
  const mismatch = { ...returned, body: { output: { content_ref: { ...ref.content_ref, sha256: hash('other') } } } };
  const badHash = { ...returned, body: { output: { content_ref: { ...ref.content_ref, sha256: 'not-a-hash' } } } };
  const relative = { ...returned, body: { output: { content_ref: { ...ref.content_ref, path: 'relative.txt' } } } };
  for (const candidate of [mismatch, badHash, relative]) {
    const fresh = new ArchiveEvidenceStore(':memory:', 'owner', ['demo']);
    assert.throws(() => fresh.importBatch(batch(0, 1, [candidate])));
    fresh.close();
  }
});
