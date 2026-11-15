import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { localDayWindow } from '../src/day.ts';
import { JournalError } from '../src/errors.ts';
import { JournalStore } from '../src/store.ts';
import { pageOf, codexEvent, fixturePage, tempDirectory } from './helpers.ts';
import { validatePage } from '../src/trace/page.ts';

const ARCHIVE = '00000000-0000-4000-8000-000000000001';
const OPTIONS = { after: 0, archiveId: ARCHIVE, allowedProjects: ['fixture'], maxEvents: 100 };
const TRACE = 'http://127.0.0.1:9';

function open(): { store: JournalStore; close: () => void } {
  const directory = tempDirectory();
  const store = new JournalStore(path.join(directory, 'journal.sqlite'));
  store.bind(TRACE, ARCHIVE);
  return { store, close: () => store.close() };
}

test('commits a page with its cursor and replays it idempotently', () => {
  const { store, close } = open();
  try {
    const page = validatePage(fixturePage('valid/content-page-1.json'), OPTIONS);
    const first = store.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page, now: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(first, { cursor: 6, imported: 6, replayed: false });
    const replay = store.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page, now: '2026-01-01T00:00:01.000Z' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.imported, 0);
    assert.equal(store.state().cursor, 6);

    const window = localDayWindow('2026-01-01', 'Asia/Shanghai');
    assert.equal(store.eventsForDay(window.startIso, window.endIso).length, 6);
  } finally {
    close();
  }
});

test('rejects cursor gaps and keeps the committed cursor', () => {
  const { store, close } = open();
  try {
    const gap = pageOf([], { after: 5, next: 6 });
    assert.throws(() => store.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page: gap, now: '2026-01-01T00:00:00.000Z' }),
      (error: unknown) => error instanceof JournalError && error.code === 'INVALID_PAGE');
    assert.equal(store.state().cursor, 0);
  } finally {
    close();
  }
});

test('deletion tombstones clear events, mark days stale and prevent resurrection', () => {
  const { store, close } = open();
  try {
    const content = validatePage(fixturePage('valid/content-page-1.json'), OPTIONS);
    store.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page: content, now: '2026-01-01T00:00:00.000Z' });
    const deletion = validatePage(fixturePage('valid/content-deletion-page.json'), { ...OPTIONS, after: 6 });
    const removed = store.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page: deletion, now: '2026-01-01T00:00:02.000Z' });
    assert.equal(removed.cursor, 7);
    assert.equal(store.summary().events, 0);
    assert.equal(store.getDay('2026-01-01')?.status, 'stale');

    const later = pageOf([
      codexEvent({ seq: 8, kind: 'message.user', instanceId: 'fixture-device', sessionId: '11111111-2222-4333-8444-555555555555', data: { title: 'after delete' }, body: { text: 'should not be stored' } }),
    ], { after: 7, next: 8, archiveId: ARCHIVE });
    const validated = validatePage(later, { ...OPTIONS, after: 7 });
    const result = store.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page: validated, now: '2026-01-01T00:00:03.000Z' });
    assert.equal(result.imported, 0);
    assert.equal(store.summary().events, 0);
  } finally {
    close();
  }
});

test('single-writer lease can be released and taken over', () => {
  const { store, close } = open();
  try {
    store.acquireLease('host-a:1:aaa', 60, 1_000_000);
    assert.throws(() => store.acquireLease('host-a:2:bbb', 60, 1_000_500),
      (error: unknown) => error instanceof JournalError && error.code === 'FOLLOW_LOCKED');
    store.releaseLease('host-a:1:aaa');
    assert.doesNotThrow(() => store.acquireLease('host-a:2:bbb', 60, 1_001_000));
    store.releaseLease('host-a:2:bbb');
  } finally {
    close();
  }
});

test('state, cursor and events survive reopening the database', () => {
  const directory = tempDirectory();
  const database = path.join(directory, 'journal.sqlite');
  const first = new JournalStore(database);
  first.bind(TRACE, ARCHIVE);
  const page = validatePage(fixturePage('valid/content-page-1.json'), OPTIONS);
  first.commitPage({ archiveId: ARCHIVE, timeZone: 'Asia/Shanghai', page, now: '2026-01-01T00:00:00.000Z' });
  first.close();

  const second = new JournalStore(database);
  try {
    assert.equal(second.state().cursor, 6);
    const window = localDayWindow('2026-01-01', 'Asia/Shanghai');
    assert.equal(second.eventsForDay(window.startIso, window.endIso).length, 6);
    assert.equal(second.sessionStartedFor(['["codex","fixture-device","11111111-2222-4333-8444-555555555555"]']).size, 1);
  } finally {
    second.close();
  }
});

test('archive identity cannot change silently', () => {
  const { store, close } = open();
  try {
    const page = fixturePage('valid/content-page-1.json');
    assert.throws(() => store.commitPage({ archiveId: 'other-archive', timeZone: 'Asia/Shanghai', page, now: '2026-01-01T00:00:00.000Z' }),
      (error: unknown) => error instanceof JournalError && error.code === 'ARCHIVE_CHANGED');
    assert.throws(() => store.bind('http://127.0.0.1:10', ARCHIVE), (error: unknown) => error instanceof JournalError && error.code === 'TRACE_CHANGED');
  } finally {
    close();
  }
});
