import { createHash } from 'node:crypto';
import { JournalError } from '../errors.ts';

export const PAGE_VIEW = 'content';

export interface SourceRef {
  path: string;
  line: number;
  record_hash: string;
  series?: string;
}

export interface PageEvent {
  schema_version: 1;
  event_id: string;
  archive_seq: number;
  runtime: string;
  instance_id: string;
  session_id: string;
  session_key: string;
  project_id: string;
  kind: string;
  occurred_at: string | null;
  observed_at: string;
  native_type: string;
  source: SourceRef | null;
  data: Record<string, unknown>;
  body: unknown;
  raw: unknown;
}

export interface Page {
  schema_version: 1;
  archive_id: string;
  view: 'content';
  after_cursor: number;
  next_cursor: number;
  has_more: boolean;
  events: PageEvent[];
}

export interface PageValidationOptions {
  after: number;
  archiveId?: string | null;
  allowedProjects: readonly string[];
  maxEvents: number;
}

const PAGE_KEYS = ['schema_version', 'archive_id', 'view', 'after_cursor', 'next_cursor', 'has_more', 'events'];
const EVENT_KEYS = [
  'schema_version', 'event_id', 'archive_seq', 'runtime', 'instance_id', 'session_id',
  'session_key', 'project_id', 'kind', 'occurred_at', 'observed_at', 'native_type',
  'source', 'data', 'body', 'raw',
];
const SOURCE_KEYS = ['path', 'line', 'record_hash', 'series'];
const REF_KEYS = ['path', 'bytes', 'sha256', 'media_type'];
const COMMON = ['turn_id', 'root_turn_id', 'model'];
const KIND_FIELDS: Record<string, string[]> = {
  'session.started': ['cwd', 'parent_session_id', 'forked_from_session_id', 'created_at', 'cli_version', 'title'],
  'turn.context': [], 'turn.started': [], 'turn.completed': [], 'turn.interrupted': [],
  'message.user': ['title'], 'message.assistant': [], 'reasoning.summary': ['available'],
  'tool.called': ['call_id', 'name', 'input_bytes'],
  'tool.returned': ['call_id', 'output_bytes', 'status'],
  'usage.snapshot': ['cumulative', 'last_usage', 'rate_limit_only', 'cost_usd', 'cost_source'],
  'context.compacted': [], 'source.unknown': [], 'session.deleted': [],
};
const USAGE_KEYS = new Set([
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens',
  'reasoning_output_tokens', 'total_tokens',
]);
const HASH = /^[a-f0-9]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalid(message: string, code = 'INVALID_PAGE'): never {
  throw new JournalError(code, 'permanent', message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) invalid(`${where} has unknown field ${key}`);
  for (const key of allowed) if (key !== 'series' && !(key in value)) invalid(`${where} is missing ${key}`);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value: unknown, where: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value) invalid(`${where} must be a non-empty trimmed string`);
  return value;
}

function assertContentRef(value: unknown, where: string, depth = 0): void {
  if (depth > 64 || value === null || typeof value !== 'object') return;
  if ('content_ref' in (value as Record<string, unknown>)) {
    const wrapper = asRecord(value, where);
    exactKeys(wrapper, ['content_ref'], `${where}.content_ref wrapper`);
    const ref = asRecord(wrapper.content_ref, `${where}.content_ref`);
    exactKeys(ref, REF_KEYS, `${where}.content_ref`);
    const refPath = ref.path;
    if (typeof refPath !== 'string' || !refPath.startsWith('/') || /[\x00-\x1f]/.test(refPath)) {
      invalid(`${where}.content_ref.path must be an absolute path`);
    }
    if (!isSafeInt(ref.bytes) || (ref.bytes as number) < 0) invalid(`${where}.content_ref.bytes must be a nonnegative integer`);
    if (typeof ref.sha256 !== 'string' || !HASH.test(ref.sha256)) invalid(`${where}.content_ref.sha256 must be sha256 hex`);
    if (ref.media_type !== 'text/plain') invalid(`${where}.content_ref.media_type must be text/plain`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertContentRef(entry, `${where}[${index}]`, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) assertContentRef(entry, `${where}.${key}`, depth + 1);
}

function assertUsage(value: unknown, where: string): void {
  const usage = asRecord(value, where);
  for (const [key, count] of Object.entries(usage)) {
    if (!USAGE_KEYS.has(key)) invalid(`${where} has unknown usage field ${key}`);
    if (!isSafeInt(count) || (count as number) < 0) invalid(`${where}.${key} must be a nonnegative integer`);
  }
}

function validateMetadata(event: PageEvent, rawData: Record<string, unknown>): void {
  const permitted = new Set([...COMMON, ...(KIND_FIELDS[event.kind] ?? [])]);
  for (const [key, value] of Object.entries(rawData)) {
    if (!permitted.has(key)) invalid(`Unexpected metadata field ${key} for ${event.kind}`);
    if (COMMON.includes(key) && value !== null && typeof value !== 'string') invalid(`Invalid metadata ${key}`);
  }
  for (const key of COMMON) if (!(key in rawData)) invalid(`Missing metadata ${key}`);

  const optionalString = (key: string) => {
    if (key in rawData && rawData[key] !== null && typeof rawData[key] !== 'string') invalid(`Invalid metadata ${key}`);
  };
  for (const key of ['cwd', 'parent_session_id', 'forked_from_session_id', 'created_at', 'cli_version', 'title', 'call_id', 'name']) optionalString(key);
  if (typeof rawData.title === 'string' && Array.from(rawData.title).length > 80) invalid('Invalid title length');
  for (const key of ['input_bytes', 'output_bytes']) {
    if (key in rawData && rawData[key] !== null && (!isSafeInt(rawData[key]) || (rawData[key] as number) < 0)) invalid(`Invalid size ${key}`);
  }
  for (const key of ['available', 'rate_limit_only']) {
    if (key in rawData && typeof rawData[key] !== 'boolean') invalid(`Invalid flag ${key}`);
  }
  if ('cost_usd' in rawData && rawData.cost_usd !== null
    && (typeof rawData.cost_usd !== 'number' || !Number.isFinite(rawData.cost_usd) || rawData.cost_usd < 0)) {
    invalid('Invalid cost');
  }
  if ('cost_source' in rawData && rawData.cost_source !== null && !['provider', 'model_rates'].includes(String(rawData.cost_source))) {
    invalid('Invalid cost source');
  }
  if ('status' in rawData && rawData.status !== 'result_observed') invalid('Invalid status');
  for (const key of ['cumulative', 'last_usage']) if (key in rawData) assertUsage(rawData[key], `data.${key}`);
}

/** Validate one page against the shared v1 content contract. */
export function validatePage(input: unknown, options: PageValidationOptions): Page {
  const batch = asRecord(input, 'batch');
  exactKeys(batch, PAGE_KEYS, 'batch');
  if (batch.schema_version !== 1) invalid('Unsupported batch schema_version');
  if (batch.view !== PAGE_VIEW) invalid('Page is not a content batch');
  if (typeof batch.archive_id !== 'string' || !batch.archive_id) invalid('archive_id must be a non-empty string');
  if (options.archiveId !== undefined && options.archiveId !== null && batch.archive_id !== options.archiveId) {
    invalid('archive_id differs from the bound archive', 'ARCHIVE_CHANGED');
  }
  if (!isSafeInt(batch.after_cursor) || (batch.after_cursor as number) < 0) invalid('Invalid after_cursor');
  if ((batch.after_cursor as number) !== options.after) invalid(`Page starts at ${String(batch.after_cursor)}, expected ${options.after}`);
  if (!isSafeInt(batch.next_cursor) || (batch.next_cursor as number) < (batch.after_cursor as number)) invalid('Invalid next_cursor');
  if (typeof batch.has_more !== 'boolean') invalid('Invalid has_more');
  if (!Array.isArray(batch.events)) invalid('Invalid events');
  if (batch.events.length > options.maxEvents) invalid('Page contains more events than requested');
  if (batch.has_more && (batch.next_cursor as number) === (batch.after_cursor as number)) invalid('Page claims more data without advancing');

  const allowed = new Set(options.allowedProjects);
  const seenIds = new Set<string>();
  const events: PageEvent[] = [];
  let previousSeq = batch.after_cursor as number;

  for (const [index, raw] of batch.events.entries()) {
    const where = `events[${index}]`;
    const event = asRecord(raw, where);
    exactKeys(event, EVENT_KEYS, where);
    if (event.schema_version !== 1) invalid(`${where} has unsupported schema_version`);
    // Envelope-level event checks apply to every event, in scope or not: they
    // keep the page/cursor accounting sound even when the row is skipped below.
    if (typeof event.event_id !== 'string' || !HASH.test(event.event_id)) invalid(`${where} has invalid event_id`);
    if (seenIds.has(event.event_id)) invalid(`${where} duplicates an event identity in the same page`);
    seenIds.add(event.event_id);
    if (!isSafeInt(event.archive_seq)) invalid(`${where} has invalid archive_seq`);
    const seq = event.archive_seq as number;
    if (seq <= previousSeq || seq > (batch.next_cursor as number)) invalid(`${where} is out of order or beyond next_cursor`);
    previousSeq = seq;
    // `projects` is the consumption scope, not an authorization list. Once Trace
    // captures everything, content pages can carry project_ids the journal does
    // not consume (for example `unscoped`). Skipping them keeps the cursor
    // moving instead of failing the whole page. Their payload checks are
    // intentionally skipped because nothing from them is stored; only the
    // envelope-level checks above (identity shape, uniqueness, archive_seq) run.
    if (typeof event.project_id !== 'string' || !event.project_id) invalid(`${where}.project_id must be a non-empty string`);
    const projectId = event.project_id;
    if (!allowed.has(projectId)) continue;
    for (const key of ['runtime', 'instance_id', 'session_id', 'session_key', 'project_id', 'kind', 'native_type']) {
      requireString(event[key], `${where}.${key}`);
    }
    const runtime = event.runtime as string;
    const instanceId = event.instance_id as string;
    const sessionId = event.session_id as string;
    const sessionKey = event.session_key as string;
    const kind = event.kind as string;
    if (sessionKey !== JSON.stringify([runtime, instanceId, sessionId])) invalid(`${where} has invalid session_key`);
    if (event.occurred_at !== null && !isTime(event.occurred_at)) invalid(`${where} has invalid occurred_at`);
    if (!isTime(event.observed_at)) invalid(`${where} has invalid observed_at`);
    const data = asRecord(event.data, `${where}.data`);

    if (kind === 'session.deleted') {
      if (event.source !== null || event.body !== null || event.raw !== null || Object.keys(data).length > 0) {
        invalid(`${where} has an invalid deletion marker`);
      }
      const expected = sha256(JSON.stringify([runtime, instanceId, sessionId, 'deleted']));
      if (event.event_id !== expected) invalid(`${where} has invalid deletion event_id`);
      events.push(event as unknown as PageEvent);
      continue;
    }

    const source = asRecord(event.source, `${where}.source`);
    exactKeys(source, SOURCE_KEYS, `${where}.source`);
    requireString(source.path, `${where}.source.path`);
    if (!isSafeInt(source.line) || (source.line as number) < 1) invalid(`${where}.source.line must be a positive integer`);
    if (typeof source.record_hash !== 'string' || !HASH.test(source.record_hash)) invalid(`${where}.source.record_hash must be sha256 hex`);
    if ('series' in source) {
      const series = requireString(source.series, `${where}.source.series`);
      if (series === sessionId) invalid(`${where}.source.series must differ from session_id`);
    }
    // Only the codex identity is reproducible from the archived envelope
    // (runtime, instance, session, optional source.series, line). Dsh identities
    // include the native row seq and per-kind identity, which the archive does
    // not retain separately, so consumers validate the hex shape only.
    if (runtime === 'codex') {
      const tuple: Array<string | number> = 'series' in source
        ? [runtime, instanceId, sessionId, String(source.series), source.line as number]
        : [runtime, instanceId, sessionId, source.line as number];
      if (event.event_id !== sha256(JSON.stringify(tuple))) invalid(`${where} has invalid codex event_id`);
    }
    validateMetadata(event as unknown as PageEvent, data);
    assertContentRef(event.body, `${where}.body`);
    assertContentRef(event.raw, `${where}.raw`);
    events.push(event as unknown as PageEvent);
  }

  // Return the filtered page: only in-scope events are consumed, while the
  // envelope (after_cursor/next_cursor/has_more) is preserved verbatim so the
  // cursor advances past skipped events. pageFingerprint() therefore hashes the
  // filtered page; filtering is deterministic, so replaying the same page keeps
  // the same fingerprint and stays idempotent in the store.
  return { ...(batch as unknown as Page), events };
}

export function pageFingerprint(page: Page): string {
  return sha256(JSON.stringify(page));
}
