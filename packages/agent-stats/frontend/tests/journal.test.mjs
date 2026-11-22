import test from 'node:test';
import assert from 'node:assert/strict';
import { getJournalDay, getJournalDays } from '../src/lib/api.ts';

test('Journal requests use only the report date, without any Stats filters', async (t) => {
  const { signal } = new AbortController();
  const days = { enabled: true, days: ['2026-11-21'] };
  const day = { date: '2026-11-21', markdown: '# 合成日报' };
  const fetch = t.mock.method(globalThis, 'fetch', async (url) =>
    Response.json(url.endsWith('/days') ? days : day),
  );

  assert.deepEqual(await getJournalDays(signal), days);
  assert.deepEqual(await getJournalDay(day.date, signal), day);
  assert.deepEqual(
    fetch.mock.calls.map(({ arguments: args }) => args),
    [
      ['/api/journal/days', { signal }],
      ['/api/journal/day?date=2026-11-21', { signal }],
    ],
  );
});

test('Journal shows the server error when a listed report disappears', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: '日报不存在' }, { status: 404 }),
  );
  await assert.rejects(getJournalDay('2026-11-21'), /日报不存在/);
});
