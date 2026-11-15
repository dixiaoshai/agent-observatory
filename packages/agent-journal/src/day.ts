import { JournalError } from './errors.ts';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new JournalError('INVALID_TIMEZONE', 'config', `Invalid time zone: ${timeZone}`);
  }
  formatterCache.set(timeZone, created);
  return created;
}

function parts(ms: number, timeZone: string): Record<string, string> {
  const raw = formatter(timeZone).formatToParts(new Date(ms));
  const out: Record<string, string> = {};
  for (const part of raw) if (part.type !== 'literal') out[part.type] = part.value;
  return out;
}

function wallClock(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function assertLocalDay(day: string): string {
  const match = DAY.exec(day);
  if (!match) throw new JournalError('INVALID_DAY', 'config', `Day must be YYYY-MM-DD: ${day}`);
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new JournalError('INVALID_DAY', 'config', `Invalid calendar day: ${day}`);
  }
  return day;
}

export function addLocalDays(day: string, delta: number): string {
  assertLocalDay(day);
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(year, month - 1, date + delta);
  return new Date(ms).toISOString().slice(0, 10);
}

export function previousLocalDay(day: string): string {
  return addLocalDays(day, -1);
}

/** First instant whose local calendar date is `day` (handles DST gaps at midnight). */
function firstInstantOfLocalDay(day: string, timeZone: string): number {
  assertLocalDay(day);
  formatter(timeZone);
  const anchor = Date.parse(`${day}T00:00:00Z`);
  let low = anchor - 26 * 3600_000;
  let high = anchor + 26 * 3600_000;
  if (!(localDateOf(low, timeZone) < day) || !(localDateOf(high, timeZone) >= day)) {
    throw new JournalError('INVALID_DAY_WINDOW', 'config', `Cannot locate local midnight for ${day} in ${timeZone}`);
  }
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDateOf(mid, timeZone) >= day) high = mid;
    else low = mid;
  }
  if (localDateOf(high, timeZone) !== day) {
    throw new JournalError('INVALID_DAY_WINDOW', 'config', `Local day ${day} is not observable in ${timeZone}`);
  }
  return high;
}

export interface DayWindow {
  day: string;
  timeZone: string;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  hours: number;
}

/** Half-open local-day window `[start, end)` as UTC instants. */
export function localDayWindow(day: string, timeZone: string): DayWindow {
  const startMs = firstInstantOfLocalDay(day, timeZone);
  const endMs = firstInstantOfLocalDay(addLocalDays(day, 1), timeZone);
  const hours = (endMs - startMs) / 3600_000;
  if (!(hours >= 20 && hours <= 28)) {
    throw new JournalError('INVALID_DAY_WINDOW', 'config', `Unreasonable local day length: ${hours}h`);
  }
  return { day, timeZone, startMs, endMs, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), hours };
}

export function localDateOf(isoOrMs: string | number, timeZone: string): string {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) throw new JournalError('INVALID_TIME', 'permanent', `Invalid timestamp: ${isoOrMs}`);
  const p = parts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHhmm(isoOrMs: string | number, timeZone: string): string {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return '??:??';
  const p = parts(ms, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function localNowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function isDayComplete(day: string, timeZone: string, graceHours: number, nowMs = Date.now()): boolean {
  const window = localDayWindow(day, timeZone);
  return nowMs >= window.endMs + graceHours * 3600_000;
}

export function wallClockLabel(isoOrMs: string | number, timeZone: string): string {
  return `${localDateOf(isoOrMs, timeZone)} ${localHhmm(isoOrMs, timeZone)}`;
}
