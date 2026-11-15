import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { JournalConfig } from './config.ts';
import { tokenFromEnv } from './config.ts';
import { asJournalError, JournalError } from './errors.ts';
import type { JournalStore } from './store.ts';
import { TraceClient } from './trace/client.ts';
import { validatePage } from './trace/page.ts';

const LEASE_SECONDS = 300;
const MAX_PAGES = 10_000;

export interface TraceSourceClient {
  status(): Promise<{ archiveId: string; captureMode: string; maxPageEvents: number; highWatermark: number }>;
  page(after: number, limit: number): Promise<{ body: unknown; bytes: number }>;
}

export interface SyncOptions {
  client?: TraceSourceClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export interface SyncResult {
  archive_id: string;
  cursor: number;
  imported: number;
  pages: number;
  high_watermark: number;
  replayed_pages: number;
}

function ownerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(operation: () => Promise<T>, attempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const journalError = asJournalError(error);
      lastError = journalError;
      if (journalError.klass !== 'transient' || attempt === attempts - 1) throw journalError;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw asJournalError(lastError);
}

/** Pull content pages from Trace and commit them together with the cursor. */
export async function syncArchive(config: JournalConfig, store: JournalStore, options: SyncOptions = {}): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? 3;
  const owner = ownerId();
  const clock = () => now();
  const nowIso = () => new Date(clock()).toISOString();
  const ownedClient = options.client === undefined
    ? new TraceClient({ traceUrl: config.traceUrl, token: tokenFromEnv(config), timeoutSeconds: 30 }) : undefined;
  const client = options.client ?? ownedClient!;

  store.acquireLease(owner, LEASE_SECONDS, clock());
  store.recordAttempt(nowIso());
  try {
    const status = await retry(() => client.status(), attempts, sleep);
    if (status.captureMode !== 'content') {
      throw new JournalError('VIEW_UNAVAILABLE', 'permanent', 'Trace archive is not in content mode');
    }
    store.bind(config.traceUrl, status.archiveId);

    let limit = Math.min(config.pageSize, status.maxPageEvents);
    let cursor = store.state().cursor;
    let imported = 0;
    let pages = 0;
    let replayed = 0;

    for (;;) {
      if (pages >= MAX_PAGES) throw new JournalError('TOO_MANY_PAGES', 'permanent', 'Trace stream did not converge');
      let page;
      try {
        page = await retry(() => client.page(cursor, limit), attempts, sleep);
      } catch (error) {
        const journalError = asJournalError(error);
        if (journalError.code === 'PAGE_TOO_LARGE' && limit > 50) {
          limit = Math.max(50, Math.floor(limit / 2));
          continue;
        }
        throw journalError;
      }
      // validatePage() filters events whose project_id is outside config.projects
      // (the consumption scope) and keeps the page envelope, so commitPage() only
      // ever sees in-scope events, tombstones included, while the cursor still
      // advances past skipped rows.
      const validated = validatePage(page.body, {
        after: cursor,
        archiveId: status.archiveId,
        allowedProjects: config.projects,
        maxEvents: limit,
      });
      const committed = store.commitPage({
        archiveId: status.archiveId,
        timeZone: config.timezone,
        page: validated,
        now: nowIso(),
      });
      imported += committed.imported;
      if (committed.replayed) replayed++;
      cursor = committed.cursor;
      pages++;
      if (!validated.has_more) break;
      store.renewLease(owner, LEASE_SECONDS, clock());
    }

    store.recordSuccess(nowIso());
    return {
      archive_id: status.archiveId,
      cursor,
      imported,
      pages,
      high_watermark: status.highWatermark,
      replayed_pages: replayed,
    };
  } catch (error) {
    const journalError = asJournalError(error);
    store.recordError(journalError.code, journalError.klass, nowIso());
    throw journalError;
  } finally {
    store.releaseLease(owner);
    ownedClient?.close();
  }
}
