import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { JournalError } from '../src/errors.ts';
import { dreamDay } from '../src/dream.ts';
import { localDayWindow } from '../src/day.ts';
import { JournalStore } from '../src/store.ts';
import { syncArchive } from '../src/sync.ts';
import { validatePage } from '../src/trace/page.ts';
import { codexEvent, configFor, fixturePage, pageOf, startTraceServer, useTestToken } from './helpers.ts';
import { DynamicProvider } from './fake-provider.ts';

const DAY = '2026-01-01';
const AFTER_GRACE = Date.parse('2026-01-02T00:00:00.000Z');
const DURING_DAY = Date.parse('2026-01-01T12:00:00.000Z');

test('writes a deterministic note, skips an unchanged rerun and bumps revisions on force', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json'), fixturePage('valid/content-deletion-page.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'], graceHours: 0 });
  const store = new JournalStore(config.database);
  try {
    await syncArchive(config, store);
    const first = await dreamDay(config, store, DAY, { now: AFTER_GRACE });
    assert.equal(first.status, 'written');
    assert.equal(first.sessions, 1);
    assert.equal(first.revision, 1);
    assert.equal(existsSync(first.output_path), true);
    assert.equal(readFileSync(first.output_path, 'utf8').includes('Fixture session'), true);
    assert.equal(store.getDay(DAY)?.status, 'final');
    assert.equal(store.getDay(DAY)?.revision, 1);

    const second = await dreamDay(config, store, DAY, { now: AFTER_GRACE });
    assert.equal(second.status, 'skipped');
    assert.equal(second.revision, 1);

    const forced = await dreamDay(config, store, DAY, { now: AFTER_GRACE, force: true });
    assert.equal(forced.status, 'written');
    assert.equal(forced.revision, 2);

    const preview = await dreamDay(config, store, DAY, { now: DURING_DAY, today: true });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.output_path, path.join(config.outputDirectory, 'preview', `${DAY}.md`));
    assert.equal(existsSync(preview.output_path), true);
    assert.equal(store.getDay(DAY)?.revision, 2);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('refuses to finalize before the grace window', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'], graceHours: 6 });
  const store = new JournalStore(config.database);
  try {
    await syncArchive(config, store);
    const end = Date.parse(localDayWindow(DAY, config.timezone).endIso);
    await assert.rejects(
      () => dreamDay(config, store, DAY, { now: end + 6 * 3600_000 - 1 }),
      (error: unknown) => error instanceof JournalError && error.code === 'DAY_NOT_READY',
    );
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('deletion after a finalized note makes the next dream regenerate it', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json'), fixturePage('valid/content-deletion-page.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, { projects: ['fixture'], graceHours: 0 });
  const store = new JournalStore(config.database);
  try {
    await syncArchive(config, store);
    await dreamDay(config, store, DAY, { now: AFTER_GRACE });
    await syncArchive(config, store);
    assert.equal(store.getDay(DAY)?.status, 'stale');

    const regenerated = await dreamDay(config, store, DAY, { now: AFTER_GRACE });
    assert.equal(regenerated.status, 'written');
    assert.equal(regenerated.sessions, 0);
    assert.equal(readFileSync(regenerated.output_path, 'utf8').includes('无内容'), true);
    assert.equal(store.getDay(DAY)?.revision, 2);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('backfilled history is excluded by default and included explicitly', async () => {
  const directory = configFor('http://127.0.0.1:9', { projects: ['fixture'], graceHours: 0 });
  const store = new JournalStore(directory.database);
  try {
    const archiveId = '00000000-0000-4000-8000-000000000001';
    store.bind('http://127.0.0.1:9', archiveId);
    const event = codexEvent({
      seq: 1, kind: 'message.user', body: { text: 'old backfilled request' },
      occurredAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z',
    });
    const page = validatePage(pageOf([event], { after: 0, next: 1, archiveId }), { after: 0, archiveId, allowedProjects: ['fixture'], maxEvents: 10 });
    store.commitPage({ archiveId, timeZone: directory.timezone, page, now: '2026-01-04T00:00:00.000Z' });

    const now = Date.parse('2026-01-04T00:00:00.000Z');
    const excluded = await dreamDay(directory, store, DAY, { now });
    assert.equal(excluded.status, 'written');
    assert.equal(excluded.sessions, 0);
    assert.equal(excluded.coverage.backfill_events, 1);
    assert.equal(readFileSync(excluded.output_path, 'utf8').includes('无内容'), true);

    const included = await dreamDay(directory, store, DAY, { now, includeBackfill: true, force: true });
    assert.equal(included.sessions, 1);
    assert.equal(readFileSync(included.output_path, 'utf8').includes('old backfilled request'), true);
  } finally {
    store.close();
  }
});


test('model mode writes a generated review and stays idempotent', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, {
    projects: ['fixture'],
    graceHours: 0,
    model: {
      provider: 'openai-compatible', base_url: 'https://api.example.com/v1', model: 'fake-model',
      api_key_env: 'JOURNAL_FAKE_KEY', timeout_seconds: 10, max_output_tokens: 500,
    },
  });
  const store = new JournalStore(config.database);
  try {
    await syncArchive(config, store);
    const provider = new DynamicProvider();
    const first = await dreamDay(config, store, DAY, { now: AFTER_GRACE, provider });
    assert.equal(first.status, 'written');
    assert.equal(first.model, 'fake-model');
    assert.equal(first.prompt_version, 1);
    assert.equal(first.usage?.calls, 2);
    const note = readFileSync(first.output_path, 'utf8');
    assert.equal(note.includes('generated: true'), true);
    assert.equal(note.includes('model: fake-model'), true);
    assert.equal(note.includes('fake highlight'), true);
    assert.equal(note.includes('## 今天做了什么'), true);
    assert.equal(note.includes('## 会话摘要'), true);

    const provider2 = new DynamicProvider();
    const second = await dreamDay(config, store, DAY, { now: AFTER_GRACE, provider: provider2 });
    assert.equal(second.status, 'skipped');
    assert.equal(provider2.calls.length, 0);

    const deterministic = await dreamDay(config, store, DAY, { now: AFTER_GRACE, force: true, useModel: false });
    assert.equal(deterministic.status, 'written');
    assert.equal(deterministic.model, null);
    assert.equal(readFileSync(deterministic.output_path, 'utf8').includes('generated: false'), true);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});

test('model mode fails clearly without a key or with invalid model output', async () => {
  const server = await startTraceServer({ pages: [fixturePage('valid/content-page-1.json')] });
  const restore = useTestToken();
  const config = configFor(server.url, {
    projects: ['fixture'],
    graceHours: 0,
    model: {
      provider: 'openai-compatible', base_url: 'https://api.example.com/v1', model: 'fake-model',
      api_key_env: 'JOURNAL_MISSING_KEY', timeout_seconds: 10, max_output_tokens: 500,
    },
  });
  const store = new JournalStore(config.database);
  try {
    await syncArchive(config, store);
    await assert.rejects(() => dreamDay(config, store, DAY, { now: AFTER_GRACE }),
      (error: unknown) => error instanceof JournalError && error.code === 'MODEL_KEY_MISSING');
    assert.equal(store.getDay(DAY), null);

    const failing = new DynamicProvider({ failMap: true });
    await assert.rejects(() => dreamDay(config, store, DAY, { now: AFTER_GRACE, provider: failing }),
      (error: unknown) => error instanceof JournalError && error.code === 'MODEL_OUTPUT');
    assert.equal(store.getDay(DAY), null);
  } finally {
    store.close();
    restore();
    await server.close();
  }
});
