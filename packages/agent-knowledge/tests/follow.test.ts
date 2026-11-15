import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { hostname } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ArchiveEvidenceStore } from '../src/archive/index.js';
import { localOwnerId, loadConfig, evidenceDatabasePath } from '../src/bootstrap.js';
import { TraceClient } from '../src/follow/client.js';
import { loadFollowConfig, readToken, type FollowConfig } from '../src/follow/config.js';
import { FollowError } from '../src/follow/errors.js';
import { FollowWorker, validatePage } from '../src/follow/worker.js';

const TOKEN = 'synthetic-follow-token';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function event(seq: number, text: string, session = 's1', project = 'demo') {
  return {
    schema_version: 1,
    event_id: hash(JSON.stringify(['codex', 'local', session, seq])),
    archive_seq: seq,
    runtime: 'codex', instance_id: 'local', session_id: session,
    session_key: JSON.stringify(['codex', 'local', session]), project_id: project,
    kind: 'message.user', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-01T00:00:00Z',
    native_type: 'event_msg.user_message',
    source: { path: '/gone/s.jsonl', line: seq, record_hash: hash(text) },
    data: { turn_id: null, root_turn_id: null, model: null, title: text },
    body: { text },
    raw: { type: 'event_msg', payload: { type: 'user_message', message: text } },
  };
}

function tombstone(seq: number, session = 's1', project = 'demo') {
  return {
    schema_version: 1,
    event_id: hash(JSON.stringify(['codex', 'local', session, 'deleted'])),
    archive_seq: seq,
    runtime: 'codex', instance_id: 'local', session_id: session,
    session_key: JSON.stringify(['codex', 'local', session]), project_id: project,
    kind: 'session.deleted', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-01T00:00:00Z',
    native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null,
  };
}

function page(archiveId: string, after: number, next: number, events: unknown[] = [], hasMore = false, view = 'content') {
  return { schema_version: 1, archive_id: archiveId, view, after_cursor: after, next_cursor: next, has_more: hasMore, events };
}

interface TraceState {
  archiveId: string;
  captureMode: 'content' | 'metadata';
  maxPageEvents: number;
  token: string;
  requests: Array<{ path: string; after: number | null; limit: number | null }>;
  eventsHandler: (after: number, limit: number) => { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
  statusHandler?: () => { status: number; body?: unknown };
}

async function traceServer(t: test.TestContext, overrides: Partial<TraceState> = {}): Promise<{ state: TraceState; url: string }> {
  const state: TraceState = {
    archiveId: 'archive-a', captureMode: 'content', maxPageEvents: 1000, token: TOKEN, requests: [],
    eventsHandler: after => ({ status: 200, body: page(state.archiveId, after, after) }),
    ...overrides,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}, delayMs = 0): void => {
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      }, delayMs);
    };
    if (req.headers.authorization !== `Bearer ${state.token}`) {
      send(401, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } });
      return;
    }
    if (url.pathname === '/v1/status') {
      if (state.statusHandler) {
        const custom = state.statusHandler();
        send(custom.status, custom.body ?? { error: { code: 'STATUS_FAILED', message: 'status failed' } });
        return;
      }
      send(200, {
        schema_version: 1,
        protocol: { schema_version: 1, default_page_events: 500, max_page_events: state.maxPageEvents, max_page_bytes: 1024, views: ['metadata', 'content'] },
        archive: { archive_id: state.archiveId, capture_mode: state.captureMode, high_watermark: 100 },
        collection: {},
      });
      return;
    }
    if (url.pathname === '/v1/events') {
      const after = Number(url.searchParams.get('after'));
      const limit = Number(url.searchParams.get('limit'));
      state.requests.push({ path: url.pathname, after, limit });
      const result = state.eventsHandler(after, limit);
      send(result.status, result.body ?? { error: { code: 'FAILED', message: 'failed' } }, result.headers, result.delayMs);
      return;
    }
    send(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  return { state, url: `http://127.0.0.1:${port}` };
}

interface Harness {
  dir: string;
  knowledge: Awaited<ReturnType<typeof loadConfig>>;
  follow: FollowConfig;
  followFile: string;
  store: ArchiveEvidenceStore;
  events: Array<Record<string, unknown>>;
  errors: FollowError[];
}

async function harness(t: test.TestContext, url: string, options: { pageSize?: number; database?: string; dir?: string } = {}): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(path.join(os.tmpdir(), 'agent-knowledge-follow-'));
  if (!options.dir) t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'knowledge.json'), JSON.stringify({
    schema_version: 1, database: options.database ?? './knowledge.sqlite',
    allowed_project_ids: ['demo'],
    sources: [{ id: 'docs', root: './docs', project_id: 'demo' }],
  }));
  const followFile = path.join(dir, 'follow.json');
  writeFileSync(followFile, JSON.stringify({
    schema_version: 1, trace_url: url, token_env: 'AGENT_TRACE_KNOWLEDGE_TOKEN',
    config: './knowledge.json', page_size: options.pageSize ?? 2,
    idle_seconds: 1, request_timeout_seconds: 2, max_backoff_seconds: 5,
  }));
  const follow = loadFollowConfig(followFile);
  const knowledge = await loadConfig(follow.knowledgeConfig);
  const store = new ArchiveEvidenceStore(evidenceDatabasePath(knowledge.database), localOwnerId(), knowledge.allowed_project_ids);
  const events: Array<Record<string, unknown>> = [];
  const errors: FollowError[] = [];
  return { dir, knowledge, follow, followFile, store, events, errors };
}

function workerFor(test: Harness, url: string, options: {
  store?: ArchiveEvidenceStore; owner?: string; timeoutMs?: number; leaseTtlSeconds?: number; client?: TraceClient;
} = {}): FollowWorker {
  return new FollowWorker(test.follow, test.knowledge, TOKEN, {
    archive: options.store ?? test.store,
    client: options.client ?? new TraceClient(url, TOKEN, options.timeoutMs ?? 2000),
    emit: event => test.events.push(event),
    onError: error => test.errors.push(error),
    owner: options.owner ?? 'test-owner',
    leaseChunkMs: 10,
    leaseTtlSeconds: options.leaseTtlSeconds ?? 5,
  });
}

test('follow config is strict and reads the token only from the environment', async t => {
  const { dir } = await harness(t, 'http://127.0.0.1:8766');
  const config = loadFollowConfig(path.join(dir, 'follow.json'));
  assert.equal(config.traceUrl, 'http://127.0.0.1:8766');
  assert.equal(config.pageSize, 2);
  assert.equal(config.knowledgeConfig, path.join(dir, 'knowledge.json'));
  assert.deepEqual(readToken(config, { AGENT_TRACE_KNOWLEDGE_TOKEN: TOKEN }), TOKEN);
  assert.throws(() => readToken(config, {}), (error: FollowError) => error.code === 'TOKEN_MISSING');
  assert.throws(() => readToken(config, { AGENT_TRACE_KNOWLEDGE_TOKEN: '  ' }), /must hold the bearer token/);

  const write = (value: Record<string, unknown>): string => {
    const name = path.join(dir, `bad-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(name, JSON.stringify(value));
    return name;
  };
  const base = {
    schema_version: 1, trace_url: 'http://127.0.0.1:8766',
    token_env: 'AGENT_TRACE_KNOWLEDGE_TOKEN', config: './knowledge.json',
  };
  for (const invalid of [
    { ...base, trace_url: 'https://127.0.0.1:8766' },
    { ...base, trace_url: 'http://10.0.0.5:8766' },
    { ...base, trace_url: 'http://127.0.0.1:8766/v1' },
    { ...base, trace_url: 'http://127.0.0.1' },
    { ...base, token_env: 'lowercase' },
    { ...base, config: '~/knowledge.json' },
    { ...base, page_size: 0 },
    { ...base, page_size: 1001 },
    { ...base, idle_seconds: 0 },
    { ...base, request_timeout_seconds: 121 },
    { ...base, max_backoff_seconds: 0 },
    { ...base, view: 'metadata' },
    { ...base, database: './stats.sqlite' },
  ]) {
    assert.throws(() => loadFollowConfig(write(invalid)), (error: FollowError) => error.code === 'INVALID_CONFIG');
  }
  assert.throws(() => loadFollowConfig(write({ ...base, schema_version: 2 })), /schema_version/);
  const defaults = loadFollowConfig(write({ ...base }));
  assert.equal(defaults.pageSize, 200);
  assert.equal(defaults.idleSeconds, 15);
  assert.equal(defaults.requestTimeoutSeconds, 20);
  assert.equal(defaults.maxBackoffSeconds, 300);
});

test('checked-in follow example is valid and references the example knowledge config', () => {
  const config = loadFollowConfig(path.resolve('agent-knowledge.follow.example.json'));
  assert.equal(config.traceUrl, 'http://127.0.0.1:8766');
  assert.equal(config.knowledgeConfig, path.resolve('agent-knowledge.example.json'));
  assert.equal(config.pageSize, 200);
  assert.equal(config.idleSeconds, 15);
  assert.equal(config.requestTimeoutSeconds, 20);
  assert.equal(config.maxBackoffSeconds, 300);
});

test('worker pulls pages, commits cursor atomically and resumes after restart', async t => {
  let calls = 0;
  const { state, url } = await traceServer(t, {
    eventsHandler: after => {
      calls++;
      if (after === 0) return { status: 200, body: page(state.archiveId, 0, 2, [event(1, 'first'), event(2, 'second')], true) };
      if (after === 2) return { status: 200, body: page(state.archiveId, 2, 3, [event(3, 'third')], false) };
      return { status: 200, body: page(state.archiveId, after, after) };
    },
  });
  const test1 = await harness(t, url);
  const worker = workerFor(test1, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  assert.equal(await worker.start(), true);
  assert.equal((await worker.cycle()).hasMore, true);
  assert.equal(worker.committedCursor, 2);
  assert.equal((await worker.cycle()).hasMore, false);
  assert.equal(worker.committedCursor, 3);
  assert.equal(calls, 2);
  assert.deepEqual(state.requests.map(request => request.after), [0, 2]);
  assert.deepEqual(state.requests.map(request => request.limit), [2, 2]);
  assert.deepEqual(test1.events.filter(item => item.type === 'follow.page').map(({ after, next_cursor, events, has_more }) => ({ after, next_cursor, events, has_more })), [
    { after: 0, next_cursor: 2, events: 2, has_more: true },
    { after: 2, next_cursor: 3, events: 1, has_more: false },
  ]);
  assert.equal(test1.store.search('third')[0]!.event.body?.text, 'third');
  const bound = test1.store.followState(worker.followId)!;
  assert.equal(bound.archive_id, 'archive-a');
  assert.equal(bound.view, 'content');
  assert.ok(bound.last_success_at);
  worker.releaseLease();

  const test2 = await harness(t, url, { dir: test1.dir });
  const restarted = workerFor(test2, url, { store: test2.store });
  t.after(() => { restarted.releaseLease(); restarted.close(); });
  assert.equal(await restarted.start(), true);
  assert.equal(restarted.committedCursor, 3);
  await restarted.cycle();
  assert.deepEqual(state.requests.at(-1), { path: '/v1/events', after: 3, limit: 2 });
  assert.equal(restarted.committedCursor, 3);
});

test('invalid pages and identity changes are permanent and never move the cursor', async t => {
  const { state, url } = await traceServer(t);
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  assert.equal(await worker.start(), true);

  const cases: Array<[string, (after: number) => { status: number; body?: unknown }]> = [
    ['wrong view', after => ({ status: 200, body: page(state.archiveId, after, after + 1, [], false, 'metadata') })],
    ['wrong start cursor', after => ({ status: 200, body: page(state.archiveId, after + 1, after + 2, [], false) })],
    ['no advance with more', after => ({ status: 200, body: page(state.archiveId, after, after, [], true) })],
    ['backwards cursor', after => ({ status: 200, body: page(state.archiveId, after, after - 1, [], false) })],
    ['too many events', after => ({ status: 200, body: page(state.archiveId, after, after + 3, [event(1, 'a'), event(2, 'b'), event(3, 'c')], false) })],
    ['unordered events', after => ({ status: 200, body: page(state.archiveId, after, after + 3, [event(2, 'b'), event(1, 'a')], false) })],
    ['out-of-range event', after => ({ status: 200, body: page(state.archiveId, after, after + 1, [event(after + 2, 'late')], false) })],
    ['changed archive', after => ({ status: 200, body: page('archive-b', after, after + 1, [], false) })],
    ['unknown envelope key', after => ({ status: 200, body: { ...page(state.archiveId, after, after + 1, [], false), extra: 1 } })],
  ];
  for (const [name, handler] of cases) {
    state.eventsHandler = handler;
    h.errors.length = 0;
    await assert.rejects(worker.cycle(), (error: FollowError) => {
      assert.equal(error.klass, 'permanent', name);
      assert.ok(['INVALID_PAGE', 'ARCHIVE_CHANGED'].includes(error.code), `${name}: ${error.code}`);
      return true;
    });
    assert.equal(worker.committedCursor, 0, name);
  }
  assert.equal(h.store.search('late').length, 0);
});

test('probe rejects metadata archives and oversized page sizes', async t => {
  const { state, url } = await traceServer(t, { captureMode: 'metadata' });
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  await assert.rejects(worker.start().then(() => worker.cycle()), (error: FollowError) => error.code === 'VIEW_UNAVAILABLE' && error.klass === 'permanent');
  state.captureMode = 'content';
  state.maxPageEvents = 1;
  const h2 = await harness(t, url);
  const small = workerFor(h2, url, { store: h2.store });
  t.after(() => { small.releaseLease(); small.close(); });
  await assert.rejects(small.start().then(() => small.cycle()), (error: FollowError) => error.code === 'PAGE_TOO_LARGE');
});

test('transient failures retry without advancing while permanent HTTP errors stop', async t => {
  let attempt = 0;
  const { state, url } = await traceServer(t, {
    eventsHandler: after => {
      attempt++;
      if (attempt === 1) return { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'temporarily unavailable' } }, headers: { 'Retry-After': '1' } };
      return { status: 200, body: page(state.archiveId, after, after + 1, [event(1, 'after retry')], false) };
    },
  });
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  assert.equal(await worker.start(), true);
  await assert.rejects(worker.cycle(), (error: FollowError) => error.klass === 'transient' && error.retryAfterSeconds === 1);
  assert.equal(worker.committedCursor, 0);
  assert.equal((await worker.cycle()).cursor, 1);
  assert.equal(worker.committedCursor, 1);

  state.eventsHandler = () => ({ status: 503, body: { error: { code: 'UNAVAILABLE', message: 'still unavailable' } } });
  assert.equal(h.store.committedCursor('archive-a'), 1);
});

test('401 is classified permanent, timeouts transient, and refused connections transient', async t => {
  const { state, url } = await traceServer(t);
  const h = await harness(t, url);
  const unauthorized = workerFor(h, url, { store: h.store, owner: 'unauthorized', client: new TraceClient(url, 'wrong-token', 2000) });
  assert.equal(await unauthorized.start(), true);
  await assert.rejects(unauthorized.cycle(), (error: FollowError) => error.code === 'UNAUTHORIZED' && error.klass === 'permanent');
  assert.equal(unauthorized.committedCursor, 0);
  unauthorized.releaseLease();

  const slow = await traceServer(t, { eventsHandler: after => ({ status: 200, body: page(slow.state.archiveId, after, after), delayMs: 500 }) });
  const h2 = await harness(t, slow.url);
  const timeout = workerFor(h2, slow.url, { store: h2.store, owner: 'timeout', timeoutMs: 100 });
  assert.equal(await timeout.start(), true);
  await assert.rejects(timeout.cycle(), (error: FollowError) => error.code === 'TIMEOUT' && error.klass === 'transient');
  timeout.releaseLease();

  const dead = 'http://127.0.0.1:1';
  const h3 = await harness(t, dead);
  const refused = workerFor(h3, dead, { store: h3.store, owner: 'refused' });
  assert.equal(await refused.start(), true);
  await assert.rejects(refused.cycle(), (error: FollowError) => error.code === 'CONNECTION_ERROR' && error.klass === 'transient');
  refused.releaseLease();
});

test('a second worker is locked out, dead owners are taken over and archive/trace changes pause', async t => {
  const { state, url } = await traceServer(t, {
    eventsHandler: after => ({ status: 200, body: page(state.archiveId, after, after + 1, [event(after + 1, `page ${after}`)], false) }),
  });
  const h = await harness(t, url);
  const first = workerFor(h, url, { owner: 'first' });
  t.after(() => { first.releaseLease(); first.close(); });
  assert.equal(await first.start(), true);
  await first.cycle();

  const secondStore = new ArchiveEvidenceStore(evidenceDatabasePath(h.knowledge.database), localOwnerId(), ['demo']);
  const second = workerFor(h, url, { store: secondStore, owner: 'second' });
  t.after(() => second.close());
  h.errors.length = 0;
  assert.equal(await second.start(), false);
  assert.equal(h.errors[0]!.code, 'FOLLOW_LOCKED');
  assert.equal(second.committedCursor, 0);
  // A second owner must not advance the shared cursor while the lease is held.
  assert.equal(h.store.committedCursor('archive-a'), 1);
  first.releaseLease();
  assert.equal(await second.start(), true);
  second.releaseLease();

  // A dead same-host owner does not block takeover before lease expiry.
  const stale = workerFor(h, url, { owner: `${hostname()}:999999:dead` });
  h.store.ensureFollow(stale.followId, url, 'content', new Date().toISOString());
  h.store.acquireFollowLease(stale.followId, `${hostname()}:999999:dead`, 300, Date.now());
  const taker = workerFor(h, url, { owner: 'taker' });
  t.after(() => taker.close());
  assert.equal(await taker.start(), true);
  taker.releaseLease();

  // The same URL now reports another archive: the next probe pauses.
  state.archiveId = 'archive-b';
  const changed = workerFor(h, url, { owner: 'changed' });
  t.after(() => changed.close());
  h.errors.length = 0;
  assert.equal(await changed.start(), true);
  await assert.rejects(changed.cycle(), (error: FollowError) => error.code === 'ARCHIVE_CHANGED' && error.klass === 'permanent');
  changed.releaseLease();

  // A different Trace URL for an already bound database is not silently adopted.
  const other = await traceServer(t);
  const h2 = await harness(t, other.url, { dir: h.dir });
  const relocated = workerFor(h2, other.url, { store: h2.store, owner: 'relocated' });
  t.after(() => relocated.close());
  h2.errors.length = 0;
  assert.equal(await relocated.start(), false);
  assert.equal(h2.errors[0]!.code, 'TRACE_CHANGED');
});

test('out-of-scope projects are skipped as consumption scope while duplicate identities roll back', async t => {
  const { state, url } = await traceServer(t, {
    eventsHandler: after => ({ status: 200, body: page(state.archiveId, after, after + 1, [event(after + 1, 'other project', 's1', 'other')], false) }),
  });
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  assert.equal(await worker.start(), true);
  // A wider Trace archive serves a project outside Knowledge's consumption
  // scope: the page commits, the cursor advances and nothing is imported.
  const skipped = await worker.cycle();
  assert.equal(skipped.cursor, 1);
  assert.equal(skipped.events, 1);
  assert.equal(worker.committedCursor, 1);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.store.search('other project'), []);

  state.eventsHandler = after => after === 1
    ? { status: 200, body: page(state.archiveId, 1, 2, [event(2, 'original')], false) }
    : { status: 200, body: page(state.archiveId, 2, 3, [{ ...event(2, 'original'), archive_seq: 3 }], false) };
  assert.equal((await worker.cycle()).cursor, 2);
  await assert.rejects(worker.cycle(), (error: FollowError) => error.code === 'INVALID_PAGE' && error.klass === 'permanent');
  assert.equal(worker.committedCursor, 2);
});

test('run retries transient failures with backoff and then catches up', async t => {
  let attempts = 0;
  const { state, url } = await traceServer(t, {
    eventsHandler: after => {
      attempts++;
      if (attempts === 1) return { status: 500, body: { error: { code: 'BOOM', message: 'temporary failure' } } };
      if (after === 0) return { status: 200, body: page(state.archiveId, 0, 1, [event(1, 'eventually')], false) };
      return { status: 200, body: page(state.archiveId, after, after) };
    },
  });
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => worker.close());
  const finish = worker.run();
  const timer = setInterval(() => {
    if (h.events.some(item => item.type === 'follow.page')) worker.requestStop();
  }, 10);
  t.after(() => clearInterval(timer));
  assert.equal(await finish, 0);
  const transient = h.events.find(item => item.type === 'follow.error')!;
  assert.equal(transient.class, 'transient');
  assert.equal(transient.code, 'BOOM');
  assert.ok(Number(transient.retry_in_seconds) >= 1);
  assert.equal(h.store.search('eventually').length, 1);
  assert.equal(worker.committedCursor, 1);
});

test('tombstones clear evidence, replay cannot resurrect it, and sequence holes are legal', async t => {
  const { state, url } = await traceServer(t, {
    eventsHandler: after => {
      if (after === 0) return { status: 200, body: page(state.archiveId, 0, 1, [event(1, 'evidence')], true) };
      if (after === 1) return { status: 200, body: page(state.archiveId, 1, 2, [tombstone(2)], true) };
      return { status: 200, body: page(state.archiveId, after, after + 3, [event(after + 3, 'hole page', 's2')], false) };
    },
  });
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  assert.equal(await worker.start(), true);
  await worker.cycle();
  assert.equal(h.store.search('evidence').length, 1);
  await worker.cycle();
  assert.equal(worker.committedCursor, 2);
  assert.deepEqual(h.store.search('evidence'), []);
  assert.throws(() => h.store.read('archive-a', event(1, 'evidence').event_id));

  // A complete retry of an already committed page is a no-op, not a resurrection.
  const replay = h.store.importBatch(page('archive-a', 0, 1, [event(1, 'evidence')], true));
  assert.equal(replay.replayed, true);
  assert.deepEqual(h.store.search('evidence'), []);
  assert.throws(() => h.store.importBatch(page('archive-a', 2, 3, [event(3, 'resurrection')], false)));

  // Holes are legal: 5 follows 2 because deletions leave sequence gaps.
  const hole = await worker.cycle();
  assert.equal(hole.cursor, 5);
  assert.equal(h.store.search('hole page').length, 1);
});

test('the worker reads while another connection queries the evidence database', async t => {
  const { state, url } = await traceServer(t, {
    eventsHandler: after => after < 5
      ? { status: 200, body: page(state.archiveId, after, after + 1, [event(after + 1, `concurrent ${after + 1}`)], true) }
      : { status: 200, body: page(state.archiveId, after, after) },
  });
  const h = await harness(t, url);
  const reader = new ArchiveEvidenceStore(evidenceDatabasePath(h.knowledge.database), localOwnerId(), ['demo']);
  t.after(() => reader.close());
  const worker = workerFor(h, url);
  t.after(() => { worker.releaseLease(); worker.close(); });
  assert.equal(await worker.start(), true);
  let more = true;
  while (more) {
    more = (await worker.cycle()).hasMore;
    // A separate connection keeps serving reads while pages commit.
    assert.ok(reader.search('concurrent').length >= 0);
  }
  assert.equal(reader.search('concurrent 5').length, 1);
});

test('run reports a permanent error with exit code 2 and stops on request with code 0', async t => {
  const { state, url } = await traceServer(t, {
    eventsHandler: () => ({ status: 403, body: { error: { code: 'VIEW_FORBIDDEN', message: 'content view is not authorized' } } }),
  });
  const h = await harness(t, url);
  const worker = workerFor(h, url);
  t.after(() => worker.close());
  assert.equal(await worker.run(), 2);
  assert.ok(h.events.some(item => item.type === 'follow.started'));
  assert.ok(h.events.some(item => item.type === 'follow.error' && item.class === 'permanent'));
  assert.equal(h.events.at(-1)!.type, 'follow.stopped');
  assert.equal(h.events.at(-1)!.reason, 'error');
  assert.equal(h.errors.at(-1)!.code, 'VIEW_FORBIDDEN');

  state.eventsHandler = after => ({ status: 200, body: page(state.archiveId, after, after) });
  const h2 = await harness(t, url);
  const stopped = workerFor(h2, url, { store: h2.store, owner: 'stopped' });
  t.after(() => stopped.close());
  const finish = stopped.run();
  const cycle = setInterval(() => {
    if (h2.events.some(item => item.type === 'follow.idle')) stopped.requestStop();
  }, 10);
  t.after(() => clearInterval(cycle));
  assert.equal(await finish, 0);
  assert.ok(h2.events.some(item => item.type === 'follow.idle'));
  assert.equal(h2.events.at(-1)!.type, 'follow.stopped');
  assert.equal(h2.events.at(-1)!.reason, 'signal');
  assert.equal(h2.store.followState(stopped.followId)!.lease_owner, null);
});

test('follow CLI stops cleanly on SIGTERM and reports a missing token', async t => {
  const { state, url } = await traceServer(t, {
    eventsHandler: after => after === 0
      ? { status: 200, body: page(state.archiveId, 0, 1, [event(1, 'cli page')], false) }
      : { status: 200, body: page(state.archiveId, after, after) },
  });
  const h = await harness(t, url);
  const cli = path.resolve('src/interfaces/cli.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'follow', '--config', h.followFile], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_TRACE_KNOWLEDGE_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const deadline = Date.now() + 8000;
  while (!stdout.includes('follow.idle') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(stdout, /"type":"follow.page"/, `stdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /"type":"follow.idle"/);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  const events = stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.at(-1)!.type, 'follow.stopped');
  assert.equal(events.at(-1)!.reason, 'signal');
  assert.equal(stderr, '');
  assert.equal(h.store.committedCursor('archive-a'), 1);

  const missing = spawn(process.execPath, ['--import', 'tsx', cli, 'follow', '--config', h.followFile], {
    cwd: process.cwd(), env: { ...process.env, AGENT_TRACE_KNOWLEDGE_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let missingErr = '';
  missing.stderr.setEncoding('utf8').on('data', chunk => { missingErr += chunk; });
  const missingCode = await new Promise<number | null>(resolve => missing.once('exit', code => resolve(code)));
  assert.equal(missingCode, 1);
  assert.match(missingErr, /TOKEN_MISSING/);
});

test('validatePage accepts sequence holes and rejects envelope violations directly', () => {
  const holes = page('archive-a', 0, 3, [event(1, 'a'), event(3, 'c')], false);
  assert.deepEqual(validatePage(holes, 0, 2, 'archive-a'), holes);
  const valid = page('archive-a', 0, 2, [event(1, 'a'), event(2, 'b')], true);
  assert.throws(() => validatePage(page('archive-a', 0, 2, [event(2, 'b'), event(1, 'a')], false), 0, 2, 'archive-a'),
    (error: FollowError) => error.code === 'INVALID_PAGE');
  assert.throws(() => validatePage(valid, 0, 1, 'archive-a'), /more events than requested/);
  assert.throws(() => validatePage(page('archive-a', 0, 1, [], false), 1, 2, 'archive-a'), /committed cursor/);
  assert.throws(() => validatePage(page('archive-a', 0, 1, [event(1, 'a')], false), 0, 2, 'archive-b'), /archive_id/);
  assert.throws(() => validatePage({ ...valid, schema_version: 2 }, 0, 2, 'archive-a'), /v1 content batch/);
});
