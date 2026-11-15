import { createHash, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { ArchiveEvidenceStore } from '../archive/index.js';
import { AgentKnowledgeError } from '../core/index.js';
import { evidenceDatabasePath, loadConfig, localOwnerId, type Config as KnowledgeConfig } from '../bootstrap.js';
import { TraceClient } from './client.js';
import { loadFollowConfig, readToken, type FollowConfig } from './config.js';
import { FollowError, type FollowErrorClass } from './errors.js';

/**
 * Knowledge follow worker.
 *
 * It pulls content pages from agent-trace and applies each page through
 * `ArchiveEvidenceStore.importBatch`, so evidence and the archive cursor commit
 * in one local transaction. Progress lives only in this database; Trace keeps
 * no delivery or acknowledgment state. The worker never reads source logs and
 * is independent of the stdio MCP process.
 */
const VIEW = 'content' as const;
const LEASE_SECONDS = 30;
const LEASE_CHUNK_MS = 10_000;
const MAX_LEASE_SECONDS = 3600;

type Emit = (event: Record<string, unknown>) => void;

/** Transport for the existing Trace v1 content protocol, not a generic event source. */
export interface FollowSource {
  status(): Promise<unknown>;
  events(after: number, limit: number): Promise<unknown>;
}

export interface FollowWorkerOptions {
  archive?: ArchiveEvidenceStore;
  client?: FollowSource;
  emit?: Emit;
  now?: () => number;
  owner?: string;
  leaseTtlSeconds?: number;
  leaseChunkMs?: number;
  random?: () => number;
  /** Defaults to one JSON line on stderr; tests inject a collector. */
  onError?: (error: FollowError) => void;
}

interface PageBatch {
  schema_version: 1;
  archive_id: string;
  view: 'content';
  after_cursor: number;
  next_cursor: number;
  has_more: boolean;
  events: Array<Record<string, unknown>>;
}

export interface FollowCycleResult {
  hasMore: boolean;
  cursor: number;
  events: number;
}

function followIdentifier(evidencePath: string): string {
  return createHash('sha256').update(JSON.stringify(['agent-knowledge-follow', VIEW, path.resolve(evidencePath)]))
    .digest('hex');
}

function processOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStatus(value: unknown): { archiveId: string; maxPageEvents: number } {
  if (!isObject(value) || value.schema_version !== 1) {
    throw new FollowError('PROTOCOL', 'permanent', 'status response does not follow protocol v1');
  }
  const protocol = value.protocol;
  const archive = value.archive;
  if (!isObject(protocol) || protocol.schema_version !== 1) {
    throw new FollowError('PROTOCOL', 'permanent', 'status response is missing the v1 protocol block');
  }
  if (!Number.isSafeInteger(protocol.max_page_events) || Number(protocol.max_page_events) < 1) {
    throw new FollowError('PROTOCOL', 'permanent', 'status response does not report max_page_events');
  }
  if (!isObject(archive) || typeof archive.archive_id !== 'string' || !archive.archive_id) {
    throw new FollowError('PROTOCOL', 'permanent', 'status response does not report an archive_id');
  }
  if (archive.capture_mode !== 'content') {
    throw new FollowError('VIEW_UNAVAILABLE', 'permanent',
      'the Trace archive was created in metadata mode and cannot serve content evidence');
  }
  return { archiveId: archive.archive_id, maxPageEvents: Number(protocol.max_page_events) };
}

const PAGE_KEYS = Object.keys({
  schema_version: 1, archive_id: 1, view: 1, after_cursor: 1, next_cursor: 1, has_more: 1, events: 1,
}).sort().join(',');

export function validatePage(value: unknown, after: number, pageSize: number, archiveId: string): PageBatch {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== PAGE_KEYS) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page envelope is not a v1 batch');
  }
  if (value.schema_version !== 1 || value.view !== VIEW) {
    throw new FollowError('INVALID_PAGE', 'permanent', `page is not a v1 ${VIEW} batch`);
  }
  if (typeof value.archive_id !== 'string' || !value.archive_id) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page is missing archive_id');
  }
  if (value.archive_id !== archiveId) {
    throw new FollowError('ARCHIVE_CHANGED', 'permanent', 'stored archive_id differs from the Trace response');
  }
  if (value.after_cursor !== after) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page does not start at the committed cursor');
  }
  if (!Number.isSafeInteger(value.next_cursor) || Number(value.next_cursor) < after) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page cursor does not advance or is invalid');
  }
  if (typeof value.has_more !== 'boolean' || !Array.isArray(value.events)) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page envelope has an invalid type');
  }
  if (value.events.length > pageSize) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page returned more events than requested');
  }
  if (value.has_more && value.next_cursor === after) {
    throw new FollowError('INVALID_PAGE', 'permanent', 'page claims more data without advancing');
  }
  let previous = after;
  for (const event of value.events) {
    if (!isObject(event) || !Number.isSafeInteger(event.archive_seq)) {
      throw new FollowError('INVALID_PAGE', 'permanent', 'page contains an invalid event');
    }
    const seq = Number(event.archive_seq);
    // Sequence holes are legitimate (deletions); strict ordering is not.
    if (seq <= previous || seq > Number(value.next_cursor)) {
      throw new FollowError('INVALID_PAGE', 'permanent', 'page contains an out-of-range or unordered event');
    }
    previous = seq;
  }
  return value as unknown as PageBatch;
}

function classify(error: unknown): FollowError {
  if (error instanceof FollowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(message)) {
    return new FollowError('LOCAL_DB_BUSY', 'transient', 'evidence database is busy');
  }
  if (error instanceof AgentKnowledgeError) {
    if (error.code === 'FORBIDDEN') return new FollowError('FORBIDDEN', 'permanent', error.message);
    if (error.code === 'ARCHIVE_CHANGED' || error.code === 'FOLLOW_LOCKED') {
      return new FollowError(error.code, 'permanent', error.message);
    }
    return new FollowError('INVALID_PAGE', 'permanent', error.message);
  }
  return new FollowError('INTERNAL', 'permanent', message);
}

export class FollowWorker {
  readonly followId: string;
  private readonly archive: ArchiveEvidenceStore;
  private readonly client: FollowSource;
  private readonly emit: Emit;
  private readonly now: () => number;
  private readonly owner: string;
  private readonly leaseTtlSeconds: number;
  private readonly leaseChunkMs: number;
  private readonly random: () => number;
  private readonly onError: (error: FollowError) => void;
  private archiveId: string | null = null;
  private cursor = 0;
  private failures = 0;
  private needsProbe = true;
  private stopping = false;
  private fatal: FollowError | null = null;
  private lastError: FollowError | null = null;
  private wake: (() => void) | null = null;

  constructor(
    readonly config: FollowConfig,
    readonly knowledge: KnowledgeConfig,
    token: string,
    options: FollowWorkerOptions = {},
  ) {
    const evidencePath = evidenceDatabasePath(knowledge.database);
    this.followId = followIdentifier(evidencePath);
    this.archive = options.archive ?? new ArchiveEvidenceStore(
      evidencePath,
      localOwnerId(),
      knowledge.allowed_project_ids,
    );
    this.client = options.client ?? new TraceClient(config.traceUrl, token, config.requestTimeoutSeconds * 1000);
    this.emit = options.emit ?? (event => { process.stdout.write(`${JSON.stringify(event)}\n`); });
    this.now = options.now ?? Date.now;
    this.owner = options.owner ?? processOwner();
    this.leaseTtlSeconds = Math.min(MAX_LEASE_SECONDS,
      options.leaseTtlSeconds ?? Math.max(LEASE_SECONDS, config.requestTimeoutSeconds + 10));
    this.leaseChunkMs = options.leaseChunkMs ?? LEASE_CHUNK_MS;
    this.random = options.random ?? Math.random;
    this.onError = options.onError ?? (error => this.stderr(error));
  }

  get committedCursor(): number { return this.cursor; }
  get boundArchiveId(): string | null { return this.archiveId; }

  requestStop(): void {
    this.stopping = true;
    this.wake?.();
  }

  /** Start, run until stopped or a permanent error, and release the lease. */
  async run(): Promise<number> {
    if (!(await this.start())) return 1;
    let reason = 'signal';
    let status = 0;
    try {
      while (!this.stopping && !this.fatal) {
        try {
          const page = await this.cycle();
          this.failures = 0;
          if (page.hasMore) continue;
          this.emit({ type: 'follow.idle', at: this.at(), cursor: this.cursor, idle_seconds: this.config.idleSeconds });
          if (await this.wait(this.config.idleSeconds * 1000)) break;
        } catch (error) {
          if (this.stopping) break;
          const failure = classify(error);
          this.recordError(failure);
          this.emitState();
          const delay = failure.klass === 'transient' ? this.backoff(failure) : null;
          this.emit({
            type: 'follow.error', at: this.at(), class: failure.klass, code: failure.code,
            message: failure.message, retry_in_seconds: delay, cursor: this.cursor,
          });
          if (failure.klass === 'permanent') {
            this.lastError = failure;
            reason = 'error';
            status = 2;
            break;
          }
          // An error can follow a takeover, a cursor move or a server restart:
          // re-probe identity before trusting the next page.
          this.needsProbe = true;
          if (await this.wait((delay ?? this.config.idleSeconds) * 1000)) break;
        }
      }
      if (this.fatal && status === 0) {
        this.recordError(this.fatal);
        this.emit({ type: 'follow.error', at: this.at(), class: this.fatal.klass, code: this.fatal.code,
          message: this.fatal.message, retry_in_seconds: null, cursor: this.cursor });
        this.lastError = this.fatal;
        reason = 'error';
        status = 2;
      }
    } finally {
      this.emitState();
      this.releaseLease();
      this.emit({ type: 'follow.stopped', at: this.at(), reason, cursor: this.cursor });
    }
    if (this.lastError) this.onError(this.lastError);
    return status;
  }

  releaseLease(): void {
    try { this.archive.releaseFollowLease(this.followId, this.owner); } catch { /* best effort */ }
  }

  /** One probe + one page; used by the loop and by deterministic tests. */
  async cycle(): Promise<FollowCycleResult> {
    if (this.needsProbe) await this.probe();
    if (this.archiveId === null) throw new FollowError('INTERNAL', 'permanent', 'worker is not bound to an archive');
    const after = this.cursor;
    this.archive.recordFollowAttempt(this.followId, this.at());
    const page = validatePage(await this.client.events(after, this.config.pageSize), after, this.config.pageSize, this.archiveId);
    let result: { archive_id: string; cursor: number; imported: number; replayed: boolean };
    try {
      result = this.archive.importBatch(page);
    } catch (error) {
      throw classify(error);
    }
    this.cursor = result.cursor;
    this.archive.recordFollowSuccess(this.followId, result.archive_id, this.at());
    if (page.events.length || page.next_cursor > page.after_cursor) {
      this.emit({ type: 'follow.page', at: this.at(), after: page.after_cursor,
        next_cursor: this.cursor, events: page.events.length, has_more: page.has_more });
    }
    return { hasMore: page.has_more, cursor: this.cursor, events: page.events.length };
  }

  close(): void {
    try { this.archive.close(); } catch { /* already closed */ }
  }

  /** Acquire the worker lease and the local committed cursor. */
  async start(): Promise<boolean> {
    try {
      const now = this.at();
      let state = this.archive.ensureFollow(this.followId, this.config.traceUrl, VIEW, now);
      state = this.archive.acquireFollowLease(this.followId, this.owner, this.leaseTtlSeconds, this.now());
      if (state.view !== VIEW) {
        throw new FollowError('FOLLOW_STATE', 'permanent', 'stored follow view is not content');
      }
      if (state.archive_id === null) {
        const bindings = this.archive.cursorBindings();
        if (bindings.length > 1) {
          throw new FollowError('FOLLOW_STATE', 'permanent',
            'evidence database holds cursors for more than one archive; rebuild explicitly');
        }
        if (bindings.length === 1) {
          this.archive.bindFollow(this.followId, bindings[0]!.archive_id, this.config.traceUrl, now);
          state = this.archive.followState(this.followId)!;
        }
      } else if (state.trace_url !== this.config.traceUrl) {
        throw new FollowError('TRACE_CHANGED', 'permanent',
          'stored follow binding points at a different Trace URL; rebuild or reset explicitly');
      }
      this.archiveId = state.archive_id;
      this.cursor = this.archiveId === null ? 0 : this.archive.committedCursor(this.archiveId);
    } catch (error) {
      const failure = classify(error);
      this.releaseLease();
      this.onError(failure);
      return false;
    }
    this.emit({ type: 'follow.started', at: this.at(), trace_url: this.config.traceUrl,
      view: VIEW, archive_id: this.archiveId, cursor: this.cursor });
    this.emitState();
    return true;
  }

  private async probe(): Promise<void> {
    const status = validateStatus(await this.client.status());
    if (this.config.pageSize > status.maxPageEvents) {
      throw new FollowError('PAGE_TOO_LARGE', 'permanent',
        `page_size ${this.config.pageSize} exceeds the server page limit ${status.maxPageEvents}; lower page_size and restart`);
    }
    if (this.archiveId !== null && this.archiveId !== status.archiveId) {
      throw new FollowError('ARCHIVE_CHANGED', 'permanent', 'stored archive_id differs from the Trace response');
    }
    try {
      this.archive.bindFollow(this.followId, status.archiveId, this.config.traceUrl, this.at());
    } catch (error) {
      throw classify(error);
    }
    if (this.archiveId === null) {
      this.archiveId = status.archiveId;
      this.cursor = this.archive.committedCursor(status.archiveId);
    }
    this.needsProbe = false;
  }

  private emitState(): void {
    let state = null;
    try { state = this.archive.followState(this.followId); } catch { /* reporting must not fail the run */ }
    this.emit({
      type: 'follow.state', at: this.at(), archive_id: this.archiveId, cursor: this.cursor,
      last_success_at: state?.last_success_at ?? null,
      last_error: state?.last_error_code
        ? { code: state.last_error_code, class: state.last_error_class, at: state.last_error_at }
        : null,
    });
  }

  private recordError(error: FollowError): void {
    try { this.archive.recordFollowError(this.followId, error.code, error.klass, this.at()); } catch { /* best effort */ }
  }

  private backoff(error: FollowError): number {
    const base = this.config.idleSeconds * (2 ** Math.min(this.failures, 10));
    let delay = Math.min(this.config.maxBackoffSeconds, base) * (0.9 + this.random() * 0.2);
    if (error.retryAfterSeconds !== undefined) delay = Math.min(error.retryAfterSeconds, this.config.maxBackoffSeconds);
    delay = Math.max(this.config.idleSeconds, Math.min(delay, this.config.maxBackoffSeconds));
    this.failures += 1;
    return Math.round(delay * 100) / 100;
  }

  /** Sleep in lease-sized chunks; true means stop, a lost lease or a fatal error. */
  private async wait(ms: number): Promise<boolean> {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      if (this.stopping) return true;
      const slice = Math.min(this.leaseChunkMs, remaining);
      await this.sleep(slice);
      remaining -= slice;
      if (this.stopping) return true;
      try {
        this.archive.renewFollowLease(this.followId, this.owner, this.leaseTtlSeconds, this.now());
      } catch (error) {
        this.fatal = classify(error);
        return true;
      }
    }
    return this.stopping;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private stderr(error: FollowError): void {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code, class: error.klass, message: error.message } })}\n`);
  }
}

/** CLI entry: validate configuration, open the evidence projection, follow until stopped. */
export async function runFollow(configPath: string): Promise<number> {
  let worker: FollowWorker | null = null;
  try {
    const config = loadFollowConfig(configPath);
    const token = readToken(config);
    const knowledge = await loadConfig(config.knowledgeConfig);
    worker = new FollowWorker(config, knowledge, token);
  } catch (error) {
    const failure = classify(error);
    process.stderr.write(`${JSON.stringify({ error: { code: failure.code, class: failure.klass, message: failure.message } })}\n`);
    return 1;
  }
  const stop = (): void => worker?.requestStop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await worker.run();
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    worker.close();
  }
}

export { FollowError, type FollowErrorClass };
