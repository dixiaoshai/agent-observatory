import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentKnowledgeError } from '../core/index.js';

const ident = z.string().min(1).max(4096);
const safeInt = z.number().int().nonnegative().safe();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const nullableString = z.string().nullable();
const jsonObject = z.record(z.string(), z.unknown());
// Content mode may externalize an oversized string. The reference is explicit,
// content-addressed and verifiable; it is never a truncated body.
const contentRefSchema = z.strictObject({
  path: ident.refine(value => path.isAbsolute(value) && !/[\x00-\x1f]/.test(value), 'Absolute content path required'),
  bytes: safeInt,
  sha256: hex,
  media_type: z.literal('text/plain'),
});
const refSchema = z.strictObject({ content_ref: contentRefSchema });

export type FollowErrorClass = 'transient' | 'permanent';
export type FollowErrorCode = string;
export interface FollowState {
  follow_id: string;
  trace_url: string;
  archive_id: string | null;
  view: string;
  created_at: string;
  updated_at: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_class: FollowErrorClass | null;
  last_error_at: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
}
const sourceSchema = z.strictObject({ path: ident, line: safeInt.refine(n => n > 0), record_hash: hex, series: ident.optional() });
const eventSchema = z.strictObject({
  schema_version: z.literal(1), event_id: hex, archive_seq: safeInt.refine(n => n > 0),
  runtime: ident, instance_id: ident, session_id: ident, session_key: ident, project_id: ident,
  kind: ident, occurred_at: nullableString, observed_at: ident, native_type: ident,
  source: sourceSchema.nullable(), data: jsonObject, body: jsonObject.nullable(), raw: jsonObject.nullable(),
});
const batchSchema = z.strictObject({ schema_version: z.literal(1), archive_id: ident,
  view: z.literal('content'), after_cursor: safeInt, next_cursor: safeInt,
  has_more: z.boolean(), events: z.array(eventSchema) });
type Event = z.infer<typeof eventSchema>;
const common = ['turn_id', 'root_turn_id', 'model'];
const fields: Record<string, string[]> = {
  'session.started': ['cwd', 'parent_session_id', 'forked_from_session_id', 'created_at', 'cli_version', 'title'],
  'turn.context': [], 'turn.started': [], 'turn.completed': [], 'turn.interrupted': [],
  'message.user': ['title'], 'message.assistant': [], 'reasoning.summary': ['available'],
  'tool.called': ['call_id', 'name', 'input_bytes'], 'tool.returned': ['call_id', 'output_bytes', 'status'],
  'usage.snapshot': ['cumulative', 'last_usage', 'rate_limit_only', 'cost_usd', 'cost_source'], 'context.compacted': [],
  'source.unknown': [], 'session.deleted': [],
};
const usageKeys = new Set(['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const validTime = (v: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const invalid = (message: string): never => { throw new AgentKnowledgeError('INVALID_ARCHIVE', message); };
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const isRef = (value: unknown): boolean => refSchema.safeParse(value).success;
const hasRef = (value: unknown, depth = 0): boolean => {
  if (depth > 64 || value === null || typeof value !== 'object') return false;
  if (isRef(value)) return true;
  if (Array.isArray(value)) return value.some(entry => hasRef(entry, depth + 1));
  return Object.values(value as Record<string, unknown>).some(entry => hasRef(entry, depth + 1));
};
const assertRefs = (value: unknown, depth = 0): void => {
  if (depth > 64 || value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if ('content_ref' in record) {
    if (!isRef(value)) invalid('Invalid content reference');
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(record)) assertRefs(entry, depth + 1);
};
function validEvent(event: Event): void {
  if (event.session_key !== JSON.stringify([event.runtime, event.instance_id, event.session_id])) invalid('Invalid session key');
  if (event.occurred_at !== null && !validTime(event.occurred_at)) invalid('Invalid event time');
  if (!validTime(event.observed_at)) invalid('Invalid observation time');
  if (event.kind === 'session.deleted') {
    if (event.source !== null || event.body !== null || event.raw !== null || Object.keys(event.data).length) invalid('Invalid deletion marker');
    if (event.event_id !== sha(JSON.stringify([event.runtime, event.instance_id, event.session_id, 'deleted']))) invalid('Invalid deletion event ID');
    return;
  }
  if (!event.source) invalid('Missing source reference');
  if (event.runtime === 'codex' && event.event_id !== sha(JSON.stringify([event.runtime, event.instance_id, event.session_id, event.source!.line]))) invalid('Invalid event ID');
  const permitted = new Set([...common, ...(fields[event.kind] ?? [])]);
  for (const [key, value] of Object.entries(event.data)) {
    if (!permitted.has(key)) invalid('Unexpected metadata field');
    if (common.includes(key) && value !== null && typeof value !== 'string') invalid('Invalid metadata');
  }
  for (const key of common) if (!(key in event.data)) invalid('Missing metadata');
  const d = event.data;
  const optionalString = (key: string) => { if (key in d && d[key] !== null && typeof d[key] !== 'string') invalid('Invalid metadata'); };
  for (const key of ['cwd', 'parent_session_id', 'forked_from_session_id', 'created_at', 'cli_version', 'title', 'call_id', 'name']) optionalString(key);
  if (typeof d.title === 'string' && Array.from(d.title).length > 80) invalid('Invalid title');
  for (const key of ['input_bytes', 'output_bytes']) if (key in d && d[key] !== null && (!Number.isSafeInteger(d[key]) || Number(d[key]) < 0)) invalid('Invalid size');
  for (const key of ['available', 'rate_limit_only']) if (key in d && typeof d[key] !== 'boolean') invalid('Invalid flag');
  if ('cost_usd' in d && d.cost_usd !== null
      && (typeof d.cost_usd !== 'number' || !Number.isFinite(d.cost_usd) || d.cost_usd < 0)) invalid('Invalid cost');
  if ('cost_source' in d && d.cost_source !== null && !['provider', 'model_rates'].includes(d.cost_source as string)) invalid('Invalid cost source');
  if ('status' in d && d.status !== 'result_observed') invalid('Invalid status');
  for (const key of ['cumulative', 'last_usage']) if (key in d) {
    if (!d[key] || typeof d[key] !== 'object' || Array.isArray(d[key])) invalid('Invalid usage');
    for (const [name, value] of Object.entries(d[key] as Record<string, unknown>)) if (!usageKeys.has(name) || !Number.isSafeInteger(value) || Number(value) < 0) invalid('Invalid usage');
  }
  if (event.raw !== null && (event.runtime === 'pi' || event.runtime === 'dsh')) {
    // Pi and dsh raw records are native session entries (type/id/message), not
    // Codex rollouts with a payload envelope; body semantics are adapter-defined.
    if (typeof event.raw.type !== 'string') invalid('Invalid raw record');
  }
  assertRefs(event.body);
  assertRefs(event.raw);
  if (event.raw !== null && event.runtime === 'codex') {
    if (typeof event.raw.type !== 'string' || !event.raw.payload || typeof event.raw.payload !== 'object' || Array.isArray(event.raw.payload)) invalid('Invalid raw record');
    const payload = event.raw.payload as Record<string, unknown>;
    const subtype = typeof payload.type === 'string' ? '.' + payload.type : '';
    if (event.native_type !== event.raw.type + subtype) invalid('Raw record type mismatch');
    if (event.body !== null && event.kind === 'tool.called') {
      const value = payload.arguments ?? payload.input ?? payload.action ?? null;
      // Redaction/externalization is applied identically to body and raw, so a
      // reference must equal the raw reference, and inline values must match.
      if (!same(event.body.arguments, value)) invalid('Tool arguments mismatch');
    }
    if (event.body !== null && event.kind === 'tool.returned' && !same(event.body.output, payload.output ?? null)) invalid('Tool output mismatch');
    if (event.body !== null && ['message.user', 'message.assistant', 'reasoning.summary', 'context.compacted'].includes(event.kind)) {
      const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
        ? value.map(part => typeof part === 'string' ? part : part !== null && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : '').join('\n') : '';
      let original: unknown;
      if (event.kind === 'reasoning.summary') original = event.raw.type === 'event_msg' ? payload.text : payload.summary;
      else if (event.kind === 'context.compacted') original = payload.message ?? payload.summary;
      else original = event.raw.type === 'event_msg' ? payload.message : payload.content;
      if (isRef(event.body.text)) {
        // A joined message can be externalized while raw holds the pieces;
        // require that raw still carries a verifiable reference rather than
        // silently accepting an unreferenced body.
        if (!hasRef(original)) invalid('Message content reference mismatch');
      } else if (!same(event.body.text, text(original))) invalid('Message content mismatch');
    }
  }
}

/** Isolated archive projection. The shared archive remains the evidence authority. */
export class ArchiveEvidenceStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly ownerId: string, private readonly allowedProjectIds: readonly string[]) {
    if (!ownerId || !allowedProjectIds.length) invalid('Owner and project scope required');
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS archive_evidence_cursors(owner_id TEXT NOT NULL,archive_id TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(owner_id,archive_id));
      CREATE TABLE IF NOT EXISTS archive_evidence_pages(owner_id TEXT NOT NULL,archive_id TEXT NOT NULL,start_cursor INTEGER NOT NULL,end_cursor INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(owner_id,archive_id,start_cursor,end_cursor));
      CREATE TABLE IF NOT EXISTS archive_evidence_events(owner_id TEXT NOT NULL,archive_id TEXT NOT NULL,event_id TEXT NOT NULL,seq INTEGER NOT NULL,session_key TEXT NOT NULL,project_id TEXT NOT NULL,payload TEXT NOT NULL,search_text TEXT NOT NULL,PRIMARY KEY(owner_id,archive_id,event_id),UNIQUE(owner_id,archive_id,seq));
      CREATE TABLE IF NOT EXISTS archive_evidence_deleted(owner_id TEXT NOT NULL,archive_id TEXT NOT NULL,session_key TEXT NOT NULL,PRIMARY KEY(owner_id,archive_id,session_key));
      CREATE INDEX IF NOT EXISTS archive_evidence_scope ON archive_evidence_events(owner_id,project_id,archive_id,seq);
      CREATE TABLE IF NOT EXISTS archive_follow_state(
        follow_id TEXT PRIMARY KEY, trace_url TEXT NOT NULL, archive_id TEXT, view TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_attempt_at TEXT, last_success_at TEXT,
        last_error_code TEXT, last_error_class TEXT, last_error_at TEXT,
        lease_owner TEXT, lease_expires_at REAL);`);
    } catch (error) { this.db.close(); throw error; }
  }
  private scope(projectId?: string): readonly string[] {
    if (projectId !== undefined && !this.allowedProjectIds.includes(projectId)) throw new AgentKnowledgeError('FORBIDDEN', 'Project is outside the configured scope');
    return projectId === undefined ? this.allowedProjectIds : [projectId];
  }
  importBatch(input: unknown): { archive_id: string; cursor: number; imported: number; replayed: boolean } {
    const parsed = batchSchema.safeParse(input);
    if (!parsed.success) return invalid('Invalid archive batch');
    const batch = parsed.data;
    if (batch.next_cursor < batch.after_cursor || (batch.has_more && batch.next_cursor === batch.after_cursor)) invalid('Invalid cursor range');
    let previous = batch.after_cursor;
    for (const event of batch.events) {
      if (event.archive_seq <= previous || event.archive_seq > batch.next_cursor) invalid('Invalid event order');
      previous = event.archive_seq;
      // `allowed_project_ids` is a consumption scope, not a delivery gate: a
      // wider archive (e.g. full capture) may serve pages that mix projects.
      // Out-of-scope events, including deletion markers, are skipped rather
      // than rejected, so following never stalls on a newly collected project.
      if (!this.allowedProjectIds.includes(event.project_id)) continue;
      validEvent(event);
    }
    // The page fingerprint always covers the complete batch, including skipped
    // events, so replay detection keeps its meaning regardless of scope.
    const fingerprint = sha(JSON.stringify(batch));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cursor = Number(this.db.prepare('SELECT cursor FROM archive_evidence_cursors WHERE owner_id=? AND archive_id=?').get(this.ownerId, batch.archive_id)?.cursor ?? 0);
      if (batch.after_cursor !== cursor || batch.next_cursor === cursor) {
        const page = this.db.prepare('SELECT fingerprint FROM archive_evidence_pages WHERE owner_id=? AND archive_id=? AND start_cursor=? AND end_cursor=?').get(this.ownerId, batch.archive_id, batch.after_cursor, batch.next_cursor);
        if (page?.fingerprint === fingerprint && batch.next_cursor <= cursor) {
          this.db.exec('COMMIT');
          return { archive_id: batch.archive_id, cursor, imported: 0, replayed: true };
        }
        if (batch.after_cursor !== cursor) invalid('Archive cursor gap, overlapping page, or conflicting replay');
      }
      let imported = 0;
      for (const event of batch.events) {
        // Consumption scope: skip other projects without writing evidence or a
        // tombstone. The cursor below still advances to next_cursor, so the
        // page is acknowledged and the worker can keep following.
        if (!this.allowedProjectIds.includes(event.project_id)) continue;
        const binding = this.db.prepare('SELECT project_id FROM archive_evidence_events WHERE owner_id=? AND archive_id=? AND session_key=? LIMIT 1').get(this.ownerId, batch.archive_id, event.session_key);
        if (binding && binding.project_id !== event.project_id) invalid('Conflicting session project');
        if (event.kind === 'session.deleted') {
          if (this.db.prepare('SELECT 1 FROM archive_evidence_deleted WHERE owner_id=? AND archive_id=? AND session_key=?').get(this.ownerId, batch.archive_id, event.session_key)) invalid('Duplicate deletion event');
          this.db.prepare('DELETE FROM archive_evidence_events WHERE owner_id=? AND archive_id=? AND session_key=?').run(this.ownerId, batch.archive_id, event.session_key);
          this.db.prepare('INSERT OR IGNORE INTO archive_evidence_deleted(owner_id,archive_id,session_key) VALUES(?,?,?)').run(this.ownerId, batch.archive_id, event.session_key);
          continue;
        }
        if (this.db.prepare('SELECT 1 FROM archive_evidence_deleted WHERE owner_id=? AND archive_id=? AND session_key=?').get(this.ownerId, batch.archive_id, event.session_key)) invalid('Deleted session cannot be reimported');
        const existing = this.db.prepare('SELECT payload FROM archive_evidence_events WHERE owner_id=? AND archive_id=? AND event_id=?').get(this.ownerId, batch.archive_id, event.event_id);
        if (existing) invalid('Duplicate or conflicting event');
        const text = event.body === null ? '' : JSON.stringify(event.body);
        this.db.prepare('INSERT INTO archive_evidence_events VALUES(?,?,?,?,?,?,?,?)').run(this.ownerId, batch.archive_id, event.event_id, event.archive_seq, event.session_key, event.project_id, JSON.stringify(event), text);
        imported++;
      }
      this.db.prepare('INSERT INTO archive_evidence_cursors VALUES(?,?,?) ON CONFLICT(owner_id,archive_id) DO UPDATE SET cursor=excluded.cursor').run(this.ownerId, batch.archive_id, batch.next_cursor);
      this.db.prepare('INSERT OR REPLACE INTO archive_evidence_pages VALUES(?,?,?,?,?)').run(this.ownerId, batch.archive_id, batch.after_cursor, batch.next_cursor, fingerprint);
      this.db.exec('COMMIT');
      return { archive_id: batch.archive_id, cursor: batch.next_cursor, imported, replayed: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof AgentKnowledgeError) throw error;
      throw new AgentKnowledgeError('INVALID_ARCHIVE', 'Archive import failed');
    }
  }
  search(query: string, projectId?: string, limit = 5): Array<{ archive_id: string; event: Event }> {
    if (!query.trim() || query.length > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new AgentKnowledgeError('INVALID_INPUT', 'Invalid archive search');
    const projects = this.scope(projectId);
    const rows = this.db.prepare(`SELECT archive_id,payload FROM archive_evidence_events WHERE owner_id=? AND project_id IN (${projects.map(() => '?').join(',')}) AND instr(lower(search_text),lower(?))>0 ORDER BY seq DESC LIMIT ?`).all(this.ownerId, ...projects, query, limit);
    return rows.map(row => ({ archive_id: row.archive_id as string, event: JSON.parse(row.payload as string) as Event }));
  }
  read(archiveId: string, eventId: string, projectId?: string): { archive_id: string; event: Event } {
    const projects = this.scope(projectId);
    const row = this.db.prepare(`SELECT payload FROM archive_evidence_events WHERE owner_id=? AND archive_id=? AND event_id=? AND project_id IN (${projects.map(() => '?').join(',')})`).get(this.ownerId, archiveId, eventId, ...projects);
    if (!row) throw new AgentKnowledgeError('NOT_FOUND', 'Archive evidence not found in scope');
    return { archive_id: archiveId, event: JSON.parse(row.payload as string) as Event };
  }
  // -- follow worker state -------------------------------------------------
  // The worker owns its progress. These rows only record identity, health and
  // a single-worker lease; they never replace the committed archive cursor.

  followState(followId: string): FollowState | null {
    const row = this.db.prepare('SELECT * FROM archive_follow_state WHERE follow_id=?').get(followId);
    return row ? followRow(row) : null;
  }

  ensureFollow(followId: string, traceUrl: string, view: string, now: string): FollowState {
    this.db.prepare(`INSERT OR IGNORE INTO archive_follow_state(follow_id,trace_url,view,created_at,updated_at)
      VALUES(?,?,?,?,?)`).run(followId, traceUrl, view, now, now);
    const state = this.followState(followId);
    if (!state) throw new AgentKnowledgeError('INVALID_ARCHIVE', 'Cannot create follow state');
    return state;
  }

  /** Existing manual imports may have a cursor but no follow binding yet. */
  cursorBindings(): Array<{ archive_id: string; cursor: number }> {
    return this.db.prepare('SELECT archive_id,cursor FROM archive_evidence_cursors WHERE owner_id=? ORDER BY archive_id')
      .all(this.ownerId)
      .map(row => ({ archive_id: String(row.archive_id), cursor: Number(row.cursor) }));
  }

  committedCursor(archiveId: string): number {
    const row = this.db.prepare('SELECT cursor FROM archive_evidence_cursors WHERE owner_id=? AND archive_id=?')
      .get(this.ownerId, archiveId);
    return row ? Number(row.cursor) : 0;
  }

  acquireFollowLease(followId: string, owner: string, ttlSeconds: number, nowMs: number): FollowState {
    const nowSeconds = nowMs / 1000;
    const expires = nowSeconds + ttlSeconds;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.followState(followId);
      if (!state) throw new AgentKnowledgeError('INVALID_ARCHIVE', 'Follow state is missing');
      if (state.lease_owner && state.lease_owner !== owner
          && state.lease_expires_at !== null && state.lease_expires_at > nowSeconds
          && leaseOwnerAlive(state.lease_owner)) {
        throw new AgentKnowledgeError('FOLLOW_LOCKED', 'Another follow worker holds the lease for this evidence database');
      }
      this.db.prepare('UPDATE archive_follow_state SET lease_owner=?, lease_expires_at=? WHERE follow_id=?')
        .run(owner, expires, followId);
      this.db.exec('COMMIT');
      return this.followState(followId)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  renewFollowLease(followId: string, owner: string, ttlSeconds: number, nowMs: number): void {
    const result = this.db.prepare('UPDATE archive_follow_state SET lease_expires_at=? WHERE follow_id=? AND lease_owner=?')
      .run(nowMs / 1000 + ttlSeconds, followId, owner);
    if (Number(result.changes) !== 1) {
      throw new AgentKnowledgeError('FOLLOW_LOCKED', 'Follow lease was lost; another worker may have taken over');
    }
  }

  releaseFollowLease(followId: string, owner: string): void {
    this.db.prepare('UPDATE archive_follow_state SET lease_owner=NULL, lease_expires_at=NULL WHERE follow_id=? AND lease_owner=?')
      .run(followId, owner);
  }

  bindFollow(followId: string, archiveId: string, traceUrl: string, now: string): void {
    const result = this.db.prepare(`UPDATE archive_follow_state SET archive_id=?, trace_url=?, updated_at=?
      WHERE follow_id=? AND (archive_id IS NULL OR archive_id=?)`).run(archiveId, traceUrl, now, followId, archiveId);
    if (Number(result.changes) !== 1) {
      throw new AgentKnowledgeError('ARCHIVE_CHANGED', 'Stored archive_id differs from the Trace response');
    }
  }

  recordFollowAttempt(followId: string, now: string): void {
    this.db.prepare('UPDATE archive_follow_state SET last_attempt_at=?, updated_at=? WHERE follow_id=?')
      .run(now, now, followId);
  }

  recordFollowSuccess(followId: string, archiveId: string, now: string): void {
    this.db.prepare(`UPDATE archive_follow_state SET archive_id=?, last_success_at=?, updated_at=?,
      last_error_code=NULL, last_error_class=NULL, last_error_at=NULL WHERE follow_id=?`)
      .run(archiveId, now, now, followId);
  }

  recordFollowError(followId: string, code: string, errorClass: FollowErrorClass, now: string): void {
    this.db.prepare(`UPDATE archive_follow_state SET last_error_code=?, last_error_class=?, last_error_at=?,
      updated_at=? WHERE follow_id=?`).run(code, errorClass, now, now, followId);
  }

  close(): void { this.db.close(); }
}

/** Same-host lease owners are checked against the live process table. */
function leaseOwnerAlive(owner: string): boolean {
  const parts = owner.split(':');
  if (parts.length < 2 || parts[0] !== hostname()) return true;
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function followRow(row: Record<string, unknown>): FollowState {
  return {
    follow_id: String(row.follow_id),
    trace_url: String(row.trace_url),
    archive_id: row.archive_id === null || row.archive_id === undefined ? null : String(row.archive_id),
    view: String(row.view),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_attempt_at: row.last_attempt_at === null || row.last_attempt_at === undefined ? null : String(row.last_attempt_at),
    last_success_at: row.last_success_at === null || row.last_success_at === undefined ? null : String(row.last_success_at),
    last_error_code: row.last_error_code === null || row.last_error_code === undefined ? null : String(row.last_error_code),
    last_error_class: row.last_error_class === 'transient' || row.last_error_class === 'permanent' ? row.last_error_class : null,
    last_error_at: row.last_error_at === null || row.last_error_at === undefined ? null : String(row.last_error_at),
    lease_owner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at),
  };
}
