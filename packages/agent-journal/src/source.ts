import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { JournalConfig } from './config.ts';
import { JournalError } from './errors.ts';
import type { JournalStore } from './store.ts';
import type { Page, PageEvent } from './trace/page.ts';

/** An append-only, complete snapshot of a custom source's activity. */
export interface JournalActivity {
  id: string;
  project: string;
  session: string;
  at: string;
  kind: 'user' | 'assistant' | 'final';
  text: string;
}
export interface JournalActivitySnapshot {
  source: string;
  activities: JournalActivity[];
}

function invalid(message: string): never { throw new JournalError('INVALID_INPUT', 'config', message); }
function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${where} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${where}: unknown field ${key}`);
}
function string(value: unknown, where: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max) invalid(`${where} must be a non-empty trimmed string (max ${max} characters)`);
  return value;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Validate before touching the store. Input order and IDs are immutable across imports. */
export function parseActivitySnapshot(input: unknown, projects: readonly string[]): JournalActivitySnapshot {
  const root = record(input, 'snapshot');
  keys(root, ['source', 'activities'], 'snapshot');
  const source = string(root.source, 'source', 200);
  if (!Array.isArray(root.activities)) invalid('activities must be an array');
  const ids = new Set<string>();
  const sessions = new Map<string, string>();
  const activities = root.activities.map((value, index): JournalActivity => {
    const where = `activities[${index}]`;
    const item = record(value, where);
    keys(item, ['id', 'project', 'session', 'at', 'kind', 'text'], where);
    const id = string(item.id, `${where}.id`, 200);
    if (ids.has(id)) invalid(`${where}: duplicate id`);
    ids.add(id);
    const project = string(item.project, `${where}.project`, 200);
    if (!projects.includes(project)) invalid(`${where}: project is not configured`);
    const session = string(item.session, `${where}.session`, 200);
    if (sessions.has(session) && sessions.get(session) !== project) invalid(`${where}: session belongs to multiple projects`);
    sessions.set(session, project);
    const at = string(item.at, `${where}.at`, 64);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) invalid(`${where}.at must be a valid UTC ISO timestamp with milliseconds`);
    if (item.kind !== 'user' && item.kind !== 'assistant' && item.kind !== 'final') invalid(`${where}.kind must be user, assistant or final`);
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 100_000) invalid(`${where}.text must be non-empty text (max 100000 characters)`);
    return { id, project, session, at, kind: item.kind, text: item.text };
  });
  return { source, activities };
}

/** Import a complete append-only snapshot. Each activity commits independently and is replay-checked. */
export function importActivitySnapshot(config: JournalConfig, store: JournalStore, input: unknown): { source: string; cursor: number; imported: number; replayed: number } {
  const snapshot = parseActivitySnapshot(input, config.projects);
  const archiveId = `custom:${hash(snapshot.source)}`;
  const binding = `journal-source:${hash(snapshot.source)}`;
  const owner = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  const now = () => new Date().toISOString();
  store.acquireLease(owner, 300, Date.now());
  try {
    store.recordAttempt(now());
    store.bind(binding, archiveId);
    if (snapshot.activities.length < store.state().cursor) invalid('snapshot is shorter than the previously imported prefix');
    let imported = 0;
    let replayed = 0;
    for (const [index, activity] of snapshot.activities.entries()) {
      const seq = index + 1;
      const runtime = 'custom';
      const instance = snapshot.source;
      const event: PageEvent = {
        schema_version: 1, event_id: hash(JSON.stringify([snapshot.source, activity.id])), archive_seq: seq,
        runtime, instance_id: instance, session_id: activity.session,
        session_key: JSON.stringify([runtime, instance, activity.session]), project_id: activity.project,
        kind: { user: 'message.user', assistant: 'message.assistant', final: 'turn.completed' }[activity.kind]!,
        occurred_at: activity.at, observed_at: activity.at, native_type: activity.kind,
        source: null, data: {}, body: { text: activity.text }, raw: null,
      };
      const page: Page = { schema_version: 1, archive_id: archiveId, view: 'content', after_cursor: index, next_cursor: seq, has_more: false, events: [event] };
      const result = store.commitPage({ archiveId, timeZone: config.timezone, page, now: now() });
      imported += result.imported;
      if (result.replayed) replayed++;
      if (seq % 100 === 0) store.renewLease(owner, 300, Date.now());
    }
    store.recordSuccess(now());
    return { source: snapshot.source, cursor: store.state().cursor, imported, replayed };
  } catch (error) {
    const e = error instanceof JournalError ? error : new JournalError('IMPORT_FAILED', 'permanent', 'Activity import failed');
    store.recordError(e.code, e.klass, now());
    throw error;
  } finally { store.releaseLease(owner); }
}
