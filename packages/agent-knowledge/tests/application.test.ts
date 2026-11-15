import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AgentKnowledge } from '../src/application/index.js';
import type { SourceScanner } from '../src/application/ports.js';
import { scanSource } from '../src/ingestion/index.js';
import { SqliteStore } from '../src/storage/index.js';

async function setup(t: { after(fn: () => Promise<unknown> | void): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-app-'));
  const source = { id: 'docs', root: path.join(root, 'files'), project_id: 'alpha' };
  await cp(path.resolve('fixtures'), source.root, { recursive: true });
  // Questions label the answer paths and are not part of the searchable corpus.
  await rm(path.join(source.root, 'questions.json'));
  const database = path.join(root, 'data', 'knowledge.sqlite');
  const store = new SqliteStore(database);
  const config = { owner_id: 'local:test', allowed_project_ids: ['alpha'], sources: [source] };
  const app = new AgentKnowledge(config, store.repositories, store.uow, store.index, { scan: scanSource });
  t.after(() => { store.close(); });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source, database, store, config, app };
}

test('SQLite retrieval passes 10 labeled Chinese/code questions with verifiable line references', async (t) => {
  const { source, app } = await setup(t);
  const sync = await app.sync('docs', 'first');
  assert.equal(sync.added, 10);
  const questions = JSON.parse(await readFile('fixtures/questions.json', 'utf8')) as Array<{ query: string; path: string }>;
  let correct = 0;
  for (const question of questions) {
    const results = await app.search(question.query);
    const answer = results.find((hit) => hit.record.source_refs[0].path === question.path);
    if (!answer) continue;
    correct++;
    const record = await app.read(answer.record.id);
    const ref = record.source_refs[0];
    const original = await readFile(path.join(source.root, ref.path), 'utf8');
    const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    assert.equal(record.content, lines.slice(ref.start_line - 1, ref.end_line).join(''));
    assert.match(ref.content_hash, /^[a-f0-9]{64}$/);
    assert.ok(ref.source_version_id);
  }
  assert.equal(correct, 10);
  assert.deepEqual(await app.search('火星电梯量子传送xyznonexistent'), []);
  await assert.rejects(app.search(' '), /query/);
  await assert.rejects(app.search('x', undefined, 1000), /limit/);
});

test('sync is incremental and idempotent; stale, superseded and deleted records cannot be read', async (t) => {
  const { source, app, store, config } = await setup(t);
  const first = await app.sync('docs', 'first');
  assert.deepEqual(await app.sync('docs', 'first'), first);
  assert.equal((await app.sync('docs', 'second')).unchanged, 10);
  const old = (await app.search('刷新令牌'))[0]!.record;
  const filePath = path.join(source.root, old.source_refs[0].path);
  await writeFile(filePath, '认证方案：会话标识使用 secureCookieV2。\n');
  assert.ok((await app.search('刷新令牌')).every((hit) => hit.record.id !== old.id)); // Fail closed before sync too.
  await assert.rejects(app.read(old.id), /unavailable/);
  assert.equal((await app.sync('docs', 'third')).updated, 1);
  const updated = (await app.search('secureCookieV2'))[0]!.record;
  assert.notEqual(updated.source_refs[0].content_hash, old.source_refs[0].content_hash);
  await assert.rejects(app.read(old.id), /unavailable/);
  await rm(filePath);
  await assert.rejects(app.read(updated.id), /unavailable/);
  assert.equal((await app.sync('docs', 'fourth')).deleted, 1);
  assert.deepEqual(await app.search('secureCookieV2'), []);
  const conflicting = new AgentKnowledge({ ...config, sources: [{ ...source, include_extensions: ['.txt'] }] }, store.repositories, store.uow, store.index, { scan: scanSource });
  await assert.rejects(conflicting.sync('docs', 'first'), /different source configuration/);
});

test('project, owner and configured-source restrictions apply equally to search and direct ID reads', async (t) => {
  const { app, config, store, source } = await setup(t);
  await app.sync('docs', 'first');
  const known = (await app.search('revokeSession'))[0]!.record;
  await assert.rejects(app.search('revokeSession', 'beta'), /outside/);
  await assert.rejects(app.read(known.id, 'beta'), /outside/);
  for (const restricted of [
    { ...config, allowed_project_ids: ['beta'] },
    { ...config, owner_id: 'another-user' },
    { ...config, sources: [] },
  ]) {
    const other = new AgentKnowledge(restricted, store.repositories, store.uow, store.index, { scan: scanSource });
    assert.deepEqual(await other.search('revokeSession'), []);
    await assert.rejects(other.read(known.id), /unavailable/);
  }
  const rebound = new AgentKnowledge({ ...config, sources: [{ ...source, root: path.dirname(source.root) }] }, store.repositories, store.uow, store.index, { scan: scanSource });
  await assert.rejects(rebound.read(known.id), /binding changed/);
  await assert.rejects(rebound.sync('docs', 'rebound'), /binding changed/);
});

test('failed scans keep prior data; deletion purges snapshots, records, derived index and request receipts', async (t) => {
  const { app, config, store, database } = await setup(t);
  await app.sync('docs', 'first');
  const known = (await app.search('revokeSession'))[0]!.record;
  const failing = new AgentKnowledge(config, store.repositories, store.uow, store.index, { scan: async () => { throw new Error('I/O failure'); } });
  await assert.rejects(failing.sync('docs', 'fail'), /I\/O failure/);
  assert.equal((await app.read(known.id)).id, known.id);
  await app.deleteSource('docs');
  assert.deepEqual(await app.search('revokeSession'), []);
  await assert.rejects(app.read(known.id), /unavailable/);
  const inspect = new DatabaseSync(database);
  try {
    for (const table of ['records', 'file_versions', 'search_documents', 'requests']) {
      assert.equal(inspect.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    }
    assert.equal(inspect.prepare('SELECT deleted FROM sources').get()!.deleted, 1);
  } finally { inspect.close(); }
  assert.equal((await app.sync('docs', 'first')).added, 10); // An explicit new sync can re-import.
});

test('index rebuild and database reopen preserve source identity and results', async (t) => {
  const { app, config, database } = await setup(t);
  await app.sync('docs', 'first');
  const record = (await app.search('verify_password_hash'))[0]!.record;
  const inspect = new DatabaseSync(database);
  inspect.exec('DELETE FROM search_documents');
  inspect.close();
  assert.deepEqual(await app.search('verify_password_hash'), []);
  assert.equal(await app.rebuildIndex(), 10);
  const reopened = new SqliteStore(database);
  try {
    const nextSession = new AgentKnowledge(config, reopened.repositories, reopened.uow, reopened.index, { scan: scanSource });
    assert.equal((await nextSession.read(record.id)).id, record.id);
    assert.equal((await nextSession.search('verify_password_hash'))[0]!.record.id, record.id);
  } finally { reopened.close(); }
});

test('concurrent scans use conditional versions and cannot restore a deleted source', async (t) => {
  const { app, config, store } = await setup(t);
  await app.sync('docs', 'first');
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scanning = new Promise<void>((resolve) => { started = resolve; });
  const scanner: SourceScanner = { scan: async (source) => {
    const snapshot = await scanSource(source);
    started();
    await gate;
    return snapshot;
  } };
  const delayed = new AgentKnowledge(config, store.repositories, store.uow, store.index, scanner);
  const pending = delayed.sync('docs', 'delayed');
  await scanning;
  await app.deleteSource('docs');
  release();
  await assert.rejects(pending, /changed during scanning/);
  assert.deepEqual(await app.search('revokeSession'), []);
});

test('in-flight reads recheck active state after source validation', async (t) => {
  const { app, config, store } = await setup(t);
  await app.sync('docs', 'first');
  const record = (await app.search('revokeSession'))[0]!.record;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scanning = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new AgentKnowledge(config, store.repositories, store.uow, store.index, { scan: async (source) => {
    const result = await scanSource(source);
    started();
    await gate;
    return result;
  } });
  const read = delayed.read(record.id);
  await scanning;
  await app.deleteSource('docs');
  release();
  await assert.rejects(read, /deleted while being read/);
});

test('deletion also cancels an in-flight first import with no persisted source yet', async (t) => {
  const { app, config, store } = await setup(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scanning = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new AgentKnowledge(config, store.repositories, store.uow, store.index, { scan: async (source) => {
    const result = await scanSource(source);
    started();
    await gate;
    return result;
  } });
  const sync = delayed.sync('docs', 'first');
  await scanning;
  await app.deleteSource('docs');
  release();
  await assert.rejects(sync, /changed during scanning/);
  assert.deepEqual(await app.search('revokeSession'), []);
});
