import test from 'node:test';
import assert from 'node:assert/strict';
import { JournalError } from '../src/errors.ts';
import { JournalStore } from '../src/store.ts';
import { syncArchive } from '../src/sync.ts';
import { validatePage } from '../src/trace/page.ts';
import {
  FIXTURE_ARCHIVE, TOKEN_ENV, codexEvent, configFor, deletionEvent, fixturePage, pageOf,
  startTraceServer, useTestToken,
} from './helpers.ts';

test('sync imports pages, binds the archive and resumes from the cursor', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json'), fixturePage('valid/content-deletion-page.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'] });
  const store = new JournalStore(config.database);
  try {
    const first = await syncArchive(config, store);
    assert.equal(first.archive_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(first.cursor, 6);
    assert.equal(first.imported, 6);

    const second = await syncArchive(config, store);
    assert.equal(second.cursor, 7);
    assert.equal(second.imported, 0);
    assert.equal(store.summary().events, 0);
    assert.equal(store.getDay('2026-01-01')?.status, 'stale');

    const third = await syncArchive(config, store);
    assert.equal(third.cursor, 7);
    assert.equal(third.imported, 0);
    assert.equal(third.pages, 1);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('sync rejects unauthorized clients and leaves the cursor', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')] });
  const config = configFor(server.url, { projects: ['fixture'] });
  const store = new JournalStore(config.database);
  const previous = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = 'wrong-token';
  try {
    await assert.rejects(() => syncArchive(config, store), (error: unknown) => error instanceof JournalError && error.code === 'UNAUTHORIZED');
    assert.equal(store.state().cursor, 0);
    assert.equal(store.state().lastErrorClass, 'permanent');
  } finally {
    if (previous === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previous;
    store.close();
    await server.close();
  }
});

test('sync skips projects outside the consumption scope instead of failing', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['other-project'] });
  const store = new JournalStore(config.database);
  try {
    const result = await syncArchive(config, store);
    assert.equal(result.cursor, 6);
    assert.equal(result.imported, 0);
    assert.equal(store.summary().events, 0);
    assert.equal(store.state().lastErrorCode, null);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('sync imports only in-scope events from a mixed page and replays it idempotently', async () => {
  // The last event is a deletion marker for the same session as the in-scope
  // events, but it belongs to an out-of-scope project: it must be skipped too,
  // otherwise committing it would tombstone the imported session.
  const foreignDeletion = deletionEvent({ seq: 4 });
  foreignDeletion.project_id = 'unscoped';
  foreignDeletion.instance_id = 'fixture-device';
  foreignDeletion.session_key = JSON.stringify(['codex', 'fixture-device', '11111111-2222-4333-8444-555555555555']);
  const mixed = pageOf([
    codexEvent({ seq: 1, kind: 'session.started', projectId: 'fixture' }),
    codexEvent({ seq: 2, kind: 'message.user', projectId: 'unscoped' }),
    codexEvent({ seq: 3, kind: 'turn.completed', projectId: 'fixture' }),
    foreignDeletion,
  ], { after: 0, next: 4 });
  const server = await startTraceServer({ pages: [mixed], highWatermark: 4 });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'] });
  const store = new JournalStore(config.database);
  try {
    const first = await syncArchive(config, store);
    assert.equal(first.cursor, 4);
    assert.equal(first.imported, 2);
    assert.equal(first.replayed_pages, 0);
    assert.equal(store.summary().events, 2);
    assert.equal(store.summary().sessions, 1);

    // The filtered page replays idempotently: same fingerprint, no re-import.
    const validated = validatePage(mixed, {
      after: 0, archiveId: FIXTURE_ARCHIVE, allowedProjects: ['fixture'], maxEvents: 100,
    });
    const replay = store.commitPage({
      archiveId: FIXTURE_ARCHIVE, timeZone: 'Asia/Shanghai', page: validated, now: '2026-01-01T00:00:02.000Z',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.imported, 0);
    assert.equal(store.summary().events, 2);
    assert.equal(store.state().cursor, 4);

    const second = await syncArchive(config, store);
    assert.equal(second.cursor, 4);
    assert.equal(second.imported, 0);
    assert.equal(second.pages, 1);
    assert.equal(store.summary().events, 2);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('sync halves the page size when Trace reports PAGE_TOO_LARGE', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')], maxLimit: 100 });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'], pageSize: 500 });
  const store = new JournalStore(config.database);
  try {
    const result = await syncArchive(config, store);
    assert.equal(result.cursor, 6);
    assert.equal(result.imported, 6);
    const limits = server.requests.filter((request) => request.path === '/v1/events').map((request) => request.limit);
    assert.ok(limits.includes(500));
    assert.ok(limits.some((limit) => limit !== null && limit < 500));
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('sync refuses to run while another writer holds the lease', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'] });
  const store = new JournalStore(config.database);
  try {
    store.acquireLease('other-host:1:dead', 300, Date.now());
    await assert.rejects(() => syncArchive(config, store), (error: unknown) => error instanceof JournalError && error.code === 'FOLLOW_LOCKED');
    store.releaseLease('other-host:1:dead');
  } finally {
    store.close();
    restore();
    await server.close();
  }
});
