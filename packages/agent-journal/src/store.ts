import { chmodSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JournalError } from './errors.ts';
import { localDateOf } from './day.ts';
import { compactEvent, eventFromRow, type StoredEvent, type StoredEventRow } from './events.ts';
import { pageFingerprint, type Page } from './trace/page.ts';

export type DayStatus = 'final' | 'stale';

export interface SyncState {
  traceUrl: string;
  archiveId: string | null;
  view: string;
  cursor: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  lastErrorAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
}

export interface DayRecord {
  day: string;
  status: DayStatus;
  revision: number;
  inputHash: string | null;
  outputPath: string | null;
  outputHash: string | null;
  updatedAt: string;
}

export interface CommitPageInput {
  archiveId: string;
  timeZone: string;
  page: Page;
  now: string;
}

export interface CommitPageResult {
  cursor: number;
  imported: number;
  replayed: boolean;
}

export interface SaveDayInput {
  day: string;
  status: DayStatus;
  revision: number;
  inputHash: string | null;
  outputPath: string | null;
  outputHash: string | null;
  now: string;
}

export interface RunRecord {
  runId: string;
  day: string;
  model: string | null;
  promptVersion: number | null;
  inputHash: string;
  status: 'written' | 'preview' | 'skipped' | 'failed';
  outputPath: string | null;
  outputHash: string | null;
  cost: Record<string, unknown> | null;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  trace_url TEXT NOT NULL,
  archive_id TEXT,
  view TEXT NOT NULL DEFAULT 'content',
  cursor INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_class TEXT,
  last_error_at TEXT,
  lease_owner TEXT,
  lease_expires_at REAL
);
INSERT OR IGNORE INTO sync_state(id, trace_url, view, cursor) VALUES (1, '', 'content', 0);

CREATE TABLE IF NOT EXISTS pages (
  archive_id TEXT NOT NULL,
  start_cursor INTEGER NOT NULL,
  end_cursor INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(archive_id, start_cursor, end_cursor)
);

CREATE TABLE IF NOT EXISTS events (
  archive_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT,
  observed_at TEXT NOT NULL,
  native_type TEXT NOT NULL,
  source_json TEXT,
  data_json TEXT NOT NULL,
  body_text TEXT,
  body_json TEXT,
  has_content_ref INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(archive_id, event_id),
  UNIQUE(archive_id, seq)
);
CREATE INDEX IF NOT EXISTS events_day ON events(occurred_at);
CREATE INDEX IF NOT EXISTS events_session ON events(archive_id, session_key);

CREATE TABLE IF NOT EXISTS tombstones (
  archive_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY(archive_id, session_key)
);

CREATE TABLE IF NOT EXISTS days (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT,
  output_path TEXT,
  output_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  model TEXT,
  prompt_version INTEGER,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  output_path TEXT,
  output_hash TEXT,
  cost_json TEXT,
  created_at TEXT NOT NULL
);
`;

export class JournalStore {
  readonly database: string;
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.database = databasePath;
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
      throw error;
    }
  }

  private stateRow(): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as Record<string, unknown> | undefined;
    if (!row) throw new JournalError('STORE_CORRUPT', 'permanent', 'sync_state row is missing');
    return row;
  }

  state(): SyncState {
    const row = this.stateRow();
    return {
      traceUrl: String(row.trace_url ?? ''),
      archiveId: row.archive_id === null || row.archive_id === undefined ? null : String(row.archive_id),
      view: String(row.view ?? 'content'),
      cursor: Number(row.cursor ?? 0),
      lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined ? null : String(row.last_attempt_at),
      lastSuccessAt: row.last_success_at === null || row.last_success_at === undefined ? null : String(row.last_success_at),
      lastErrorCode: row.last_error_code === null || row.last_error_code === undefined ? null : String(row.last_error_code),
      lastErrorClass: row.last_error_class === null || row.last_error_class === undefined ? null : String(row.last_error_class),
      lastErrorAt: row.last_error_at === null || row.last_error_at === undefined ? null : String(row.last_error_at),
      leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
      leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at),
    };
  }

  recordAttempt(now: string): void {
    this.db.prepare('UPDATE sync_state SET last_attempt_at = ? WHERE id = 1').run(now);
  }

  recordSuccess(now: string): void {
    this.db.prepare(`UPDATE sync_state SET last_success_at = ?, last_error_code = NULL,
      last_error_class = NULL, last_error_at = NULL WHERE id = 1`).run(now);
  }

  recordError(code: string, klass: string, now: string): void {
    this.db.prepare('UPDATE sync_state SET last_error_code = ?, last_error_class = ?, last_error_at = ? WHERE id = 1')
      .run(code, klass, now);
  }

  /** Bind the sync state to one archive and Trace URL; never silently switch. */
  bind(traceUrl: string, archiveId: string): void {
    const state = this.state();
    if (state.archiveId !== null && state.traceUrl !== traceUrl) {
      throw new JournalError('TRACE_CHANGED', 'permanent', 'Stored trace_url differs from the configured Trace URL');
    }
    if (state.archiveId !== null && state.archiveId !== archiveId) {
      throw new JournalError('ARCHIVE_CHANGED', 'permanent', 'Stored archive_id differs from the Trace response');
    }
    this.db.prepare('UPDATE sync_state SET trace_url = ?, archive_id = ? WHERE id = 1').run(traceUrl, archiveId);
  }

  acquireLease(owner: string, ttlSeconds: number, nowMs: number): SyncState {
    return this.transaction(() => {
      const state = this.state();
      const nowSeconds = nowMs / 1000;
      if (state.leaseOwner && state.leaseOwner !== owner
        && state.leaseExpiresAt !== null && state.leaseExpiresAt > nowSeconds
        && leaseOwnerAlive(state.leaseOwner)) {
        throw new JournalError('FOLLOW_LOCKED', 'permanent', 'Another journal process holds the lease');
      }
      this.db.prepare('UPDATE sync_state SET lease_owner = ?, lease_expires_at = ? WHERE id = 1')
        .run(owner, nowSeconds + ttlSeconds);
      return this.state();
    });
  }

  renewLease(owner: string, ttlSeconds: number, nowMs: number): void {
    const result = this.db.prepare('UPDATE sync_state SET lease_expires_at = ? WHERE id = 1 AND lease_owner = ?')
      .run(nowMs / 1000 + ttlSeconds, owner);
    if (Number(result.changes) !== 1) throw new JournalError('FOLLOW_LOCKED', 'permanent', 'Journal lease was lost');
  }

  releaseLease(owner: string): void {
    this.db.prepare('UPDATE sync_state SET lease_owner = NULL, lease_expires_at = NULL WHERE id = 1 AND lease_owner = ?').run(owner);
  }

  /** Transactional page import. Page may be replayed verbatim without side effects. */
  commitPage(input: CommitPageInput): CommitPageResult {
    const { page, archiveId, timeZone, now } = input;
    const fingerprint = pageFingerprint(page);
    return this.transaction(() => {
      const state = this.state();
      if (state.archiveId !== archiveId) throw new JournalError('ARCHIVE_CHANGED', 'permanent', 'Archive changed during sync');
      if (page.after_cursor !== state.cursor) {
        const replay = this.db.prepare(`SELECT fingerprint FROM pages
          WHERE archive_id = ? AND start_cursor = ? AND end_cursor = ?`)
          .get(archiveId, page.after_cursor, page.next_cursor) as Record<string, unknown> | undefined;
        if (replay && replay.fingerprint === fingerprint && page.next_cursor <= state.cursor) {
          return { cursor: state.cursor, imported: 0, replayed: true };
        }
        throw new JournalError('INVALID_PAGE', 'permanent', 'Archive cursor gap, overlapping page, or conflicting replay');
      }

      let imported = 0;
      for (const event of page.events) {
        const sessionKey = event.session_key;
        if (event.kind === 'session.deleted') {
          const rows = this.db.prepare('SELECT occurred_at FROM events WHERE archive_id = ? AND session_key = ?')
            .all(archiveId, sessionKey) as Array<Record<string, unknown>>;
          const days = new Set<string>();
          for (const row of rows) {
            const occurred = row.occurred_at === null ? null : String(row.occurred_at);
            if (occurred) {
              try { days.add(localDateOf(occurred, timeZone)); } catch { /* ignore malformed time */ }
            }
          }
          this.db.prepare('DELETE FROM events WHERE archive_id = ? AND session_key = ?').run(archiveId, sessionKey);
          this.db.prepare('INSERT OR IGNORE INTO tombstones(archive_id, session_key, deleted_at) VALUES (?, ?, ?)')
            .run(archiveId, sessionKey, now);
          this.markDaysStale([...days], now);
          continue;
        }
        const tombstoned = this.db.prepare('SELECT 1 FROM tombstones WHERE archive_id = ? AND session_key = ?')
          .get(archiveId, sessionKey);
        if (tombstoned) continue;
        const existing = this.db.prepare('SELECT seq, data_json FROM events WHERE archive_id = ? AND event_id = ?')
          .get(archiveId, event.event_id) as Record<string, unknown> | undefined;
        if (existing) {
          if (Number(existing.seq) === event.archive_seq && String(existing.data_json) === JSON.stringify(event.data)) continue;
          throw new JournalError('INVALID_PAGE', 'permanent', 'Duplicate or conflicting event');
        }
        const compact = compactEvent(archiveId, event);
        try {
          this.db.prepare(`INSERT INTO events(archive_id, event_id, seq, session_key, session_id, instance_id,
            runtime, project_id, kind, occurred_at, observed_at, native_type, source_json, data_json,
            body_text, body_json, has_content_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(archiveId, compact.eventId, compact.seq, compact.sessionKey, compact.sessionId, compact.instanceId,
              compact.runtime, compact.projectId, compact.kind, compact.occurredAt, compact.observedAt, compact.nativeType,
              compact.source ? JSON.stringify(compact.source) : null, JSON.stringify(compact.data),
              compact.bodyText, compact.bodyJson, compact.hasContentRef ? 1 : 0);
        } catch {
          throw new JournalError('INVALID_PAGE', 'permanent', 'Duplicate or conflicting event sequence');
        }
        imported++;
      }
      this.db.prepare('UPDATE sync_state SET cursor = ? WHERE id = 1').run(page.next_cursor);
      this.db.prepare(`INSERT OR REPLACE INTO pages(archive_id, start_cursor, end_cursor, fingerprint)
        VALUES (?, ?, ?, ?)`).run(archiveId, page.after_cursor, page.next_cursor, fingerprint);
      return { cursor: page.next_cursor, imported, replayed: false };
    });
  }

  eventsForDay(startIso: string, endIso: string): StoredEvent[] {
    const rows = this.db.prepare(`SELECT * FROM events WHERE occurred_at IS NOT NULL
      AND occurred_at >= ? AND occurred_at < ? ORDER BY seq`).all(startIso, endIso) as unknown as StoredEventRow[];
    return rows.map(eventFromRow);
  }

  sessionStartedFor(sessionKeys: readonly string[]): Map<string, StoredEvent> {
    const result = new Map<string, StoredEvent>();
    if (!sessionKeys.length) return result;
    const placeholders = sessionKeys.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM events WHERE kind = 'session.started'
      AND session_key IN (${placeholders}) ORDER BY seq`).all(...sessionKeys) as unknown as StoredEventRow[];
    for (const row of rows) {
      const event = eventFromRow(row);
      if (!result.has(event.sessionKey)) result.set(event.sessionKey, event);
    }
    return result;
  }

  /**
   * Latest non-empty display-name revision per session. Trace archives a
   * `session.started` snapshot and, for harnesses that rename afterwards, a
   * `session.title` event per revision; a day bundle must show the newest name
   * even when the revision happened after the day's last event.
   */
  latestTitlesFor(sessionKeys: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (!sessionKeys.length) return result;
    const placeholders = sessionKeys.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM events WHERE kind = 'session.title'
      AND session_key IN (${placeholders}) ORDER BY COALESCE(occurred_at, observed_at), seq`)
      .all(...sessionKeys) as unknown as StoredEventRow[];
    for (const row of rows) {
      const event = eventFromRow(row);
      const title = typeof event.data.title === 'string' ? event.data.title.trim() : '';
      if (title) result.set(event.sessionKey, title);
    }
    return result;
  }

  lastUsageFor(sessionKey: string, beforeIso: string): StoredEvent | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE kind = 'usage.snapshot' AND session_key = ?
      AND COALESCE(occurred_at, observed_at) < ? ORDER BY COALESCE(occurred_at, observed_at) DESC, seq DESC LIMIT 1`)
      .get(sessionKey, beforeIso) as unknown as StoredEventRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  markDaysStale(days: readonly string[], now: string): void {
    for (const day of days) {
      this.db.prepare(`INSERT INTO days(day, status, revision, updated_at) VALUES (?, 'stale', 0, ?)
        ON CONFLICT(day) DO UPDATE SET status = 'stale', updated_at = excluded.updated_at`).run(day, now);
    }
  }

  getDay(day: string): DayRecord | null {
    const row = this.db.prepare('SELECT * FROM days WHERE day = ?').get(day) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      day: String(row.day),
      status: String(row.status) === 'stale' ? 'stale' : 'final',
      revision: Number(row.revision ?? 0),
      inputHash: row.input_hash === null || row.input_hash === undefined ? null : String(row.input_hash),
      outputPath: row.output_path === null || row.output_path === undefined ? null : String(row.output_path),
      outputHash: row.output_hash === null || row.output_hash === undefined ? null : String(row.output_hash),
      updatedAt: String(row.updated_at),
    };
  }

  saveDay(input: SaveDayInput): void {
    this.db.prepare(`INSERT INTO days(day, status, revision, input_hash, output_path, output_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET status = excluded.status, revision = excluded.revision,
        input_hash = excluded.input_hash, output_path = excluded.output_path,
        output_hash = excluded.output_hash, updated_at = excluded.updated_at`)
      .run(input.day, input.status, input.revision, input.inputHash, input.outputPath, input.outputHash, input.now);
  }

  insertRun(record: RunRecord): void {
    this.db.prepare(`INSERT INTO runs(run_id, day, model, prompt_version, input_hash, status,
      output_path, output_hash, cost_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.runId, record.day, record.model, record.promptVersion, record.inputHash, record.status,
        record.outputPath, record.outputHash, record.cost ? JSON.stringify(record.cost) : null, record.createdAt);
  }

  summary(): { events: number; sessions: number; days: number; runs: number; state: SyncState } {
    const events = Number((this.db.prepare('SELECT count(*) AS n FROM events').get() as Record<string, unknown>).n ?? 0);
    const sessions = Number((this.db.prepare('SELECT count(DISTINCT session_key) AS n FROM events').get() as Record<string, unknown>).n ?? 0);
    const days = Number((this.db.prepare('SELECT count(*) AS n FROM days').get() as Record<string, unknown>).n ?? 0);
    const runs = Number((this.db.prepare('SELECT count(*) AS n FROM runs').get() as Record<string, unknown>).n ?? 0);
    return { events, sessions, days, runs, state: this.state() };
  }
}

/** Same-host lease owners are checked against the live process table. */
function leaseOwnerAlive(owner: string): boolean {
  const parts = owner.split(':');
  if (parts.length < 2 || parts[0] !== hostname()) return true;
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
