import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JournalConfig } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import type { Page, PageEvent } from '../src/trace/page.ts';

export const TOKEN_ENV = 'JOURNAL_TEST_TOKEN';
export const FIXTURE_ARCHIVE = '00000000-0000-4000-8000-000000000001';
export const TOKEN = 'test-token';

export interface TraceServerOptions {
  archiveId?: string;
  pages?: Page[];
  highWatermark?: number;
  maxLimit?: number;
}

export interface TraceServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ path: string; after: number | null; limit: number | null }>;
}

export async function startTraceServer(options: TraceServerOptions = {}): Promise<TraceServer> {
  const archiveId = options.archiveId ?? FIXTURE_ARCHIVE;
  const pages = options.pages ?? [];
  const requests: TraceServer['requests'] = [];
  let port = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    requests.push({
      path: url.pathname,
      after: url.searchParams.has('after') ? Number(url.searchParams.get('after')) : null,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : null,
    });
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'INVALID_HOST', message: 'bad host' } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'bad token' } }));
      return;
    }
    if (url.pathname === '/v1/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        schema_version: 1,
        protocol: { schema_version: 1, default_page_events: 500, max_page_events: 1000, max_page_bytes: 33_554_432, views: ['metadata', 'content'] },
        archive: {
          archive_id: archiveId,
          capture_mode: 'content',
          high_watermark: options.highWatermark ?? pages.reduce((max, page) => Math.max(max, page.next_cursor), 0),
        },
        collection: { enabled: false, state: 'disabled', started_at: null, heartbeat_at: null, scan_interval_seconds: null },
      }));
      return;
    }
    if (url.pathname === '/v1/events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '500');
      if (url.searchParams.get('view') !== 'content') {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'FORBIDDEN_VIEW', message: 'view not allowed' } }));
        return;
      }
      if (options.maxLimit !== undefined && limit > options.maxLimit) {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'PAGE_TOO_LARGE', message: 'page too large' } }));
        return;
      }
      const page = pages.find((candidate) => candidate.after_cursor === after);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(page ?? {
        schema_version: 1, archive_id: archiveId, view: 'content',
        after_cursor: after, next_cursor: after, has_more: false, events: [],
      }));
      void limit;
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'unknown path' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function tempDirectory(prefix = 'agent-journal-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export interface ConfigOverrides {
  traceUrl: string;
  projects?: string[];
  graceHours?: number;
  pageSize?: number;
  timezone?: string;
  outputDirectory?: string;
  database?: string;
  model?: Record<string, unknown> | null;
}

export function writeConfig(directory: string, overrides: ConfigOverrides): string {
  const config = {
    schema_version: 1,
    timezone: overrides.timezone ?? 'Asia/Shanghai',
    database: overrides.database ?? path.join(directory, 'journal.sqlite'),
    trace_url: overrides.traceUrl,
    token_env: TOKEN_ENV,
    output_directory: overrides.outputDirectory ?? path.join(directory, 'daily'),
    projects: overrides.projects ?? ['fixture'],
    page_size: overrides.pageSize ?? 500,
    finalize: { grace_hours: overrides.graceHours ?? 0, max_days_per_run: 7, late_observed_hours: 36 },
    budget: { max_input_tokens_per_day: 120000, max_output_tokens_per_day: 10000 },
    model: overrides.model === undefined ? null : overrides.model,
  };
  const configPath = path.join(directory, 'agent-journal.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

export function configFor(traceUrl: string, overrides: Omit<ConfigOverrides, 'traceUrl'> = {}): JournalConfig {
  const directory = tempDirectory();
  const configPath = writeConfig(directory, { traceUrl, ...overrides });
  return loadConfig(configPath);
}

export function useTestToken(): () => void {
  const previous = process.env[TOKEN_ENV];
  process.env[TOKEN_ENV] = TOKEN;
  return () => {
    if (previous === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previous;
  };
}

// Vendored synthetic protocol fixtures are required, even in a standalone checkout.
export const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixtures/protocol');

export function loadFixture(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, relative), 'utf8'));
}

export function fixturePage(relative: string): Page {
  return loadFixture(relative) as Page;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let lineCounter = 100;

export interface EventOverrides {
  seq: number;
  kind: string;
  data?: Record<string, unknown>;
  body?: unknown;
  raw?: unknown;
  sessionId?: string;
  instanceId?: string;
  runtime?: string;
  archiveId?: string;
  projectId?: string;
  occurredAt?: string | null;
  observedAt?: string;
  line?: number;
}

/** Minimal valid codex event, used to build synthetic pages in tests. */
export function codexEvent(overrides: EventOverrides): PageEvent {
  const runtime = overrides.runtime ?? 'codex';
  const instanceId = overrides.instanceId ?? 'fixture-device';
  const sessionId = overrides.sessionId ?? '11111111-2222-4333-8444-555555555555';
  const line = overrides.line ?? lineCounter++;
  const common = { turn_id: 'turn-1', root_turn_id: null, model: 'test-model' };
  return {
    schema_version: 1,
    event_id: sha256(JSON.stringify([runtime, instanceId, sessionId, line])),
    archive_seq: overrides.seq,
    runtime,
    instance_id: instanceId,
    session_id: sessionId,
    session_key: JSON.stringify([runtime, instanceId, sessionId]),
    project_id: overrides.projectId ?? 'fixture',
    kind: overrides.kind,
    occurred_at: overrides.occurredAt ?? '2026-01-01T10:00:00.000Z',
    observed_at: overrides.observedAt ?? '2026-01-01T10:00:01.000Z',
    native_type: 'test.line',
    source: { path: '/selected/test.jsonl', line, record_hash: sha256(`line-${line}`) },
    data: { ...common, ...(overrides.data ?? {}) },
    body: overrides.body === undefined ? null : overrides.body,
    raw: overrides.raw === undefined ? null : overrides.raw,
  };
}

export function pageOf(events: PageEvent[], options: { after?: number; next?: number; hasMore?: boolean; archiveId?: string } = {}): Page {
  return {
    schema_version: 1,
    archive_id: options.archiveId ?? FIXTURE_ARCHIVE,
    view: 'content',
    after_cursor: options.after ?? 0,
    next_cursor: options.next ?? (events.length ? events[events.length - 1]!.archive_seq : options.after ?? 0),
    has_more: options.hasMore ?? false,
    events,
  };
}

export function deletionEvent(options: { seq: number; sessionId?: string; occurredAt?: string; observedAt?: string }): PageEvent {
  const runtime = 'codex';
  const instanceId = 'test-device';
  const sessionId = options.sessionId ?? '11111111-2222-4333-8444-555555555555';
  return {
    schema_version: 1,
    event_id: sha256(JSON.stringify([runtime, instanceId, sessionId, 'deleted'])),
    archive_seq: options.seq,
    runtime,
    instance_id: instanceId,
    session_id: sessionId,
    session_key: JSON.stringify([runtime, instanceId, sessionId]),
    project_id: 'fixture',
    kind: 'session.deleted',
    occurred_at: options.occurredAt ?? '2026-01-01T10:00:10.000Z',
    observed_at: options.observedAt ?? '2026-01-01T10:00:11.000Z',
    native_type: 'test.deleted',
    source: null,
    data: {},
    body: null,
    raw: null,
  };
}
