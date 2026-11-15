import type { PageEvent, SourceRef } from './trace/page.ts';

const TEXT_LIMIT = 8_000;
const ARGUMENTS_LIMIT = 8_000;

export interface StoredEvent {
  archiveId: string;
  eventId: string;
  seq: number;
  sessionKey: string;
  sessionId: string;
  instanceId: string;
  runtime: string;
  projectId: string;
  kind: string;
  occurredAt: string | null;
  observedAt: string;
  nativeType: string;
  source: SourceRef | null;
  data: Record<string, unknown>;
  bodyText: string | null;
  bodyJson: string | null;
  hasContentRef: boolean;
}

function cut(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function bodyOf(event: PageEvent): Record<string, unknown> | null {
  return event.body !== null && typeof event.body === 'object' && !Array.isArray(event.body)
    ? event.body as Record<string, unknown>
    : null;
}

function hasContentRef(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === null || typeof value !== 'object') return false;
  if ('content_ref' in (value as Record<string, unknown>)) return true;
  return Object.values(value as Record<string, unknown>).some((entry) => hasContentRef(entry, depth + 1));
}

export function compactEvent(archiveId: string, event: PageEvent): StoredEvent {
  const body = bodyOf(event);
  const text = body && typeof body.text === 'string' ? cut(body.text, TEXT_LIMIT) : null;
  let bodyJson: string | null = null;
  if (event.kind === 'tool.called' && body && 'arguments' in body) {
    bodyJson = cut(JSON.stringify(body.arguments), ARGUMENTS_LIMIT);
  }
  return {
    archiveId,
    eventId: event.event_id,
    seq: event.archive_seq,
    sessionKey: event.session_key,
    sessionId: event.session_id,
    instanceId: event.instance_id,
    runtime: event.runtime,
    projectId: event.project_id,
    kind: event.kind,
    occurredAt: event.occurred_at,
    observedAt: event.observed_at,
    nativeType: event.native_type,
    source: event.source,
    data: event.data,
    bodyText: text,
    bodyJson,
    hasContentRef: hasContentRef(event.body) || hasContentRef(event.raw),
  };
}

export interface StoredEventRow {
  archive_id: string;
  event_id: string;
  seq: number;
  session_key: string;
  session_id: string;
  instance_id: string;
  runtime: string;
  project_id: string;
  kind: string;
  occurred_at: string | null;
  observed_at: string;
  native_type: string;
  source_json: string | null;
  data_json: string;
  body_text: string | null;
  body_json: string | null;
  has_content_ref: number;
}

export function eventFromRow(row: StoredEventRow): StoredEvent {
  return {
    archiveId: row.archive_id,
    eventId: row.event_id,
    seq: Number(row.seq),
    sessionKey: row.session_key,
    sessionId: row.session_id,
    instanceId: row.instance_id,
    runtime: row.runtime,
    projectId: row.project_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    nativeType: row.native_type,
    source: row.source_json ? JSON.parse(row.source_json) as SourceRef : null,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    bodyText: row.body_text,
    bodyJson: row.body_json,
    hasContentRef: Number(row.has_content_ref) === 1,
  };
}
