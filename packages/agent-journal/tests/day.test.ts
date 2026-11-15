import test from 'node:test';
import assert from 'node:assert/strict';
import { addLocalDays, assertLocalDay, isDayComplete, localDateOf, localDayWindow, previousLocalDay } from '../src/day.ts';
import { JournalError } from '../src/errors.ts';

test('Shanghai local day maps to the expected UTC half-open window', () => {
  const window = localDayWindow('2026-11-14', 'Asia/Shanghai');
  assert.equal(window.startIso, '2026-11-13T16:00:00.000Z');
  assert.equal(window.endIso, '2026-11-14T16:00:00.000Z');
  assert.equal(window.hours, 24);
});

test('local day label flips exactly at the UTC boundary', () => {
  assert.equal(localDateOf('2026-11-14T15:59:59.999Z', 'Asia/Shanghai'), '2026-11-14');
  assert.equal(localDateOf('2026-11-14T16:00:00.000Z', 'Asia/Shanghai'), '2026-11-15');
});

test('DST days keep their real length', () => {
  assert.equal(localDayWindow('2026-03-08', 'America/New_York').hours, 23);
  assert.equal(localDayWindow('2026-11-01', 'America/New_York').hours, 25);
});

test('calendar helpers handle month and leap boundaries', () => {
  assert.equal(addLocalDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addLocalDays('2024-02-28', 1), '2024-02-29');
  assert.equal(previousLocalDay('2026-01-01'), '2025-12-31');
  assert.throws(() => assertLocalDay('2026-02-30'), (error: unknown) => error instanceof JournalError && error.code === 'INVALID_DAY');
  assert.throws(() => assertLocalDay('2026-1-1'), (error: unknown) => error instanceof JournalError);
});

test('grace window gates finalization', () => {
  const day = '2026-11-14';
  const end = Date.parse(localDayWindow(day, 'Asia/Shanghai').endIso);
  assert.equal(isDayComplete(day, 'Asia/Shanghai', 6, end + 6 * 3600_000 - 1), false);
  assert.equal(isDayComplete(day, 'Asia/Shanghai', 6, end + 6 * 3600_000), true);
  assert.equal(isDayComplete(day, 'Asia/Shanghai', 0, end), true);
});

test('invalid time zones are configuration errors', () => {
  assert.throws(() => localDayWindow('2026-11-14', 'Mars/Olympus'), (error: unknown) => error instanceof JournalError && error.code === 'INVALID_TIMEZONE');
});
