import test from 'node:test';
import assert from 'node:assert/strict';
import { importActivitySnapshot } from '../src/source.ts';
import { JournalStore } from '../src/store.ts';
import { syncArchive } from '../src/sync.ts';
import { configFor } from './helpers.ts';

const snapshot = { source: 'example', activities: [
  { id: '1', project: 'fixture', session: 's', at: '2026-01-01T10:00:00.000Z', kind: 'user', text: 'Build it' },
  { id: '2', project: 'fixture', session: 's', at: '2026-01-01T10:01:00.000Z', kind: 'final', text: 'Done' },
] };

test('offline snapshot imports, replays, appends and rejects conflicts', () => {
  const config = configFor('http://localhost:1234', { projects: ['fixture'] });
  const store = new JournalStore(':memory:');
  try {
    assert.equal(importActivitySnapshot(config, store, snapshot).imported, 2);
    assert.equal(importActivitySnapshot(config, store, snapshot).replayed, 2);
    assert.equal(store.eventsForDay('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z').length, 2);
    assert.throws(() => importActivitySnapshot(config, store, { ...snapshot, activities: [{ ...snapshot.activities[0], text: 'changed' }, snapshot.activities[1]] }));
    assert.throws(() => importActivitySnapshot(config, store, { ...snapshot, source: 'other' }));
    assert.throws(() => importActivitySnapshot(config, store, { ...snapshot, activities: [snapshot.activities[0], snapshot.activities[0]] }));
    assert.equal(importActivitySnapshot(config, store, { ...snapshot, activities: [...snapshot.activities, { ...snapshot.activities[1], id: '3' }] }).imported, 1);
    assert.throws(() => importActivitySnapshot(config, store, snapshot));
    assert.equal(store.summary().events, 3);
  } finally { store.close(); }
});

test('injected structural Trace client does not require a token', async () => {
  const config = configFor('http://localhost:1234', { projects: ['fixture'] });
  config.tokenEnv = 'JOURNAL_ABSENT_TEST_TOKEN';
  delete process.env[config.tokenEnv];
  const store = new JournalStore(':memory:');
  try {
    const client = { async status() { return { archiveId: 'a', captureMode: 'content', maxPageEvents: 5, highWatermark: 0 }; }, async page() { return { body: { schema_version: 1, archive_id: 'a', view: 'content', after_cursor: 0, next_cursor: 0, has_more: false, events: [] }, bytes: 0 }; } };
    assert.equal((await syncArchive(config, store, { client })).cursor, 0);
  } finally { store.close(); }
});
