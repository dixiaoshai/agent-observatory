import { createHash } from 'node:crypto';
import type { StoredEvent } from './events.ts';
import { localDayWindow } from './day.ts';

const USER_TEXT_LIMIT = 1_200;
const FINAL_TEXT_LIMIT = 1_500;
const FALLBACK_TEXT_LIMIT = 800;
const MAX_USER_MESSAGES = 20;
const MAX_FINAL_ANSWERS = 8;
const MAX_PATHS = 40;
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
const INSTRUCTION_PATTERNS = [
  /^#\s*AGENTS\.md instructions/i,
  /^<INSTRUCTIONS>/i,
  /^<environment_context>/i,
  /^<external_/i,
  /^You are working in a shared workspace at /i,
];
const PATH_PATTERN = /(?:\/Users\/|\/private\/|\/tmp\/)[A-Za-z0-9._/-]+/g;
const SENSITIVE_PATH = /(?:^|\/)(?:\.credentials|\.env|secrets?|tokens?|cookies?|id_rsa|id_ed25519)(?:\/|$)|[.](?:pem|key|p12|pfx)$/i;

export interface TextBlock {
  at: string | null;
  title?: string | null;
  text: string;
  truncated: boolean;
  original_chars: number;
}

export interface SessionProjection {
  session_key: string;
  project_id: string;
  runtime: string;
  instance_id: string;
  session_id: string;
  title: string | null;
  cwd: string | null;
  cli_version: string | null;
  started_at: string | null;
  ended_at: string | null;
  observed_range: { first: string; last: string };
  counts: {
    events: number; user: number; instruction_like: number; assistant: number;
    final_answers: number; fallback_answers: number; answers: number;
    tools: number; tool_returns: number; usage: number; reasoning: number;
    unknown: number; interrupted: number; content_refs: number;
  };
  tool_counts: Record<string, number>;
  tool_statuses: Record<string, number>;
  touched_paths: string[];
  user_messages: TextBlock[];
  final_answers: TextBlock[];
  fallback_answers: TextBlock[];
  usage: {
    cumulative: Record<string, unknown> | null;
    cost_usd: number | null;
    cost_events: number;
    cost_sources: string[];
  };
  totals: { projected_chars: number; projected_tokens: number };
  open_ended: boolean;
}

export interface DayBundle {
  schema_version: 1;
  kind: 'journal.day-bundle';
  day: string;
  timezone: string;
  window: { start: string; end: string; hours: number };
  archive: { archive_id: string | null; cursor: number; high_watermark: number | null };
  generated_at: string;
  coverage: {
    events_scanned: number;
    events_in_day: number;
    narrative_events: number;
    backfill_events: number;
    occurred_at_missing: number;
    observed_same_day: number;
    observed_after_day: number;
    late_observed_hours: number;
  };
  totals: {
    sessions: number;
    events: number;
    kind_counts: Record<string, number>;
    projected_chars: number;
    projected_tokens: number;
    cost_usd_recorded: number;
  };
  projects: string[];
  runtimes: string[];
  sessions: SessionProjection[];
}

export interface BuildBundleInput {
  day: string;
  timeZone: string;
  events: StoredEvent[];
  sessionStarted: Map<string, StoredEvent>;
  /** Newest non-empty `session.title` revision per session, when one exists. */
  sessionTitles: Map<string, string>;
  lastUsage: Map<string, StoredEvent | null>;
  archiveId: string | null;
  cursor: number;
  highWatermark: number | null;
  lateObservedHours: number;
  includeBackfill: boolean;
  now: string;
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function truncate(text: string, limit: number): TextBlock {
  if (text.length <= limit) return { at: null, text, truncated: false, original_chars: text.length };
  return { at: null, text: `${text.slice(0, limit)}…`, truncated: true, original_chars: text.length };
}

function isInstructionLike(text: string): boolean {
  const trimmed = text.trimStart();
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function cleanPath(raw: string): string | null {
  const candidate = raw.replace(/[/.]+$/, '');
  if (candidate.length < 8) return null;
  if (candidate.split('/').filter(Boolean).length < 3) return null;
  if (/[<>[\]{}*\\\s]/.test(candidate)) return null;
  if (SENSITIVE_PATH.test(candidate)) return null;
  return candidate;
}

function collectPaths(value: unknown, into: Set<string>, budget: number): void {
  if (into.size >= budget) return;
  if (typeof value === 'string') {
    for (const match of value.match(PATH_PATTERN) ?? []) {
      const candidate = cleanPath(match);
      if (candidate) into.add(candidate);
    }
    return;
  }
  if (Array.isArray(value)) { for (const entry of value) collectPaths(entry, into, budget); return; }
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) collectPaths(entry, into, budget); }
}

function textOf(event: StoredEvent): string | null {
  return event.bodyText;
}

function pathsFromArguments(bodyJson: string | null): string[] {
  if (!bodyJson) return [];
  const paths = new Set<string>();
  try { collectPaths(JSON.parse(bodyJson), paths, MAX_PATHS); }
  catch { collectPaths(bodyJson, paths, MAX_PATHS); }
  return [...paths].sort();
}

function projectSession(sessionKey: string, events: StoredEvent[], started: StoredEvent | undefined, latestTitle: string | undefined, lastUsage: StoredEvent | null | undefined): SessionProjection {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const userEvents = ordered.filter((event) => event.kind === 'message.user');
  const finalEvents = ordered.filter((event) => event.kind === 'turn.completed' && textOf(event));
  const assistantEvents = ordered.filter((event) => event.kind === 'message.assistant' && textOf(event));
  const toolEvents = ordered.filter((event) => event.kind === 'tool.called');
  const returnedEvents = ordered.filter((event) => event.kind === 'tool.returned');
  const usageEvents = ordered.filter((event) => event.kind === 'usage.snapshot');
  const title = latestTitle
    ?? (typeof started?.data.title === 'string' && started.data.title
      ? started.data.title
      : userEvents.find((event) => typeof event.data.title === 'string' && event.data.title)?.data.title as string | undefined ?? null);

  const toolCounts: Record<string, number> = {};
  const toolStatuses: Record<string, number> = {};
  const toolPaths = new Set<string>();
  for (const event of returnedEvents) {
    const status = typeof event.data.status === 'string' ? event.data.status : 'unknown';
    toolStatuses[status] = (toolStatuses[status] ?? 0) + 1;
  }
  for (const event of toolEvents) {
    const name = typeof event.data.name === 'string' ? event.data.name : 'unknown';
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    for (const found of pathsFromArguments(event.bodyJson)) {
      if (toolPaths.size >= MAX_PATHS) break;
      toolPaths.add(found);
    }
  }

  const userMessages: TextBlock[] = [];
  let instructionLike = 0;
  for (const event of userEvents) {
    const text = textOf(event);
    if (text === null) {
      if (event.hasContentRef) userMessages.push({ at: event.occurredAt, title: typeof event.data.title === 'string' ? event.data.title : null, text: '[externalized content_ref — not read]', truncated: false, original_chars: 0 });
      continue;
    }
    if (isInstructionLike(text)) { instructionLike++; continue; }
    const block = truncate(text.trim(), USER_TEXT_LIMIT);
    block.at = event.occurredAt;
    block.title = typeof event.data.title === 'string' ? event.data.title : null;
    userMessages.push(block);
  }

  const finalAnswers: TextBlock[] = finalEvents.slice(-MAX_FINAL_ANSWERS).map((event) => ({
    ...truncate((textOf(event) ?? '').trim(), FINAL_TEXT_LIMIT), at: event.occurredAt,
  }));
  const fallbackAnswers: TextBlock[] = finalAnswers.length ? [] : assistantEvents.slice(-2).map((event) => ({
    ...truncate((textOf(event) ?? '').trim(), FALLBACK_TEXT_LIMIT), at: event.occurredAt,
  }));
  const answers = [...finalAnswers, ...fallbackAnswers];

  let cumulative: Record<string, unknown> | null = null;
  if (lastUsage && lastUsage.data.cumulative && typeof lastUsage.data.cumulative === 'object') {
    cumulative = lastUsage.data.cumulative as Record<string, unknown>;
  }
  let costUsd = 0;
  let costEvents = 0;
  const costSources = new Set<string>();
  for (const event of usageEvents) {
    if (event.data.cumulative && typeof event.data.cumulative === 'object') cumulative = event.data.cumulative as Record<string, unknown>;
    if (typeof event.data.cost_usd === 'number') { costUsd += event.data.cost_usd; costEvents++; }
    if (typeof event.data.cost_source === 'string') costSources.add(event.data.cost_source);
  }

  const unknown = ordered.filter((event) => event.kind === 'source.unknown').length;
  const reasoning = ordered.filter((event) => event.kind === 'reasoning.summary').length;
  const interrupted = ordered.filter((event) => event.kind === 'turn.interrupted').length;
  const contentRefs = ordered.filter((event) => event.hasContentRef).length;

  const projectedTexts = [
    title ?? '',
    ...userMessages.map((message) => message.title ?? message.text),
    ...finalAnswers.map((answer) => answer.text),
    ...fallbackAnswers.map((answer) => answer.text),
    ...Object.keys(toolCounts),
    ...[...toolPaths],
  ];
  const projected = projectedTexts.join('\n');

  const occurredEvents = ordered.filter((event) => event.occurredAt);
  const startedAt = occurredEvents.length ? occurredEvents[0]!.occurredAt : null;
  const endedAt = occurredEvents.length ? occurredEvents[occurredEvents.length - 1]!.occurredAt : null;

  return {
    session_key: sessionKey,
    project_id: first.projectId,
    runtime: first.runtime,
    instance_id: first.instanceId,
    session_id: first.sessionId,
    title,
    cwd: typeof started?.data.cwd === 'string' ? started.data.cwd : null,
    cli_version: typeof started?.data.cli_version === 'string' ? started.data.cli_version : null,
    started_at: startedAt,
    ended_at: endedAt,
    observed_range: { first: first.observedAt, last: last.observedAt },
    counts: {
      events: ordered.length,
      user: userEvents.length,
      instruction_like: instructionLike,
      assistant: assistantEvents.length,
      final_answers: finalAnswers.length,
      fallback_answers: fallbackAnswers.length,
      answers: answers.length,
      tools: toolEvents.length,
      tool_returns: returnedEvents.length,
      usage: usageEvents.length,
      reasoning,
      unknown,
      interrupted,
      content_refs: contentRefs,
    },
    tool_counts: toolCounts,
    tool_statuses: toolStatuses,
    touched_paths: [...toolPaths].sort().slice(0, MAX_PATHS),
    user_messages: userMessages.slice(0, MAX_USER_MESSAGES),
    final_answers: finalAnswers,
    fallback_answers: fallbackAnswers,
    usage: { cumulative, cost_usd: costUsd || null, cost_events: costEvents, cost_sources: [...costSources] },
    totals: { projected_chars: projected.length, projected_tokens: estimateTokens(projected) },
    open_ended: interrupted > 0 || (answers.length === 0 && userEvents.length > 0),
  };
}

function isBackfill(event: StoredEvent, lateObservedHours: number, dayEndMs: number): boolean {
  if (!event.occurredAt) return true;
  const occurred = Date.parse(event.occurredAt);
  const observed = Date.parse(event.observedAt);
  if (!Number.isFinite(occurred) || !Number.isFinite(observed)) return true;
  if (observed - occurred > lateObservedHours * 3600_000) return true;
  return occurred < dayEndMs && observed > dayEndMs + 24 * 3600_000;
}

/** Deterministic projection: no model, no tool output, no externalized bodies. */
export function buildDayBundle(input: BuildBundleInput): DayBundle {
  const window = localDayWindow(input.day, input.timeZone);
  const kindCounts: Record<string, number> = {};
  let occurredMissing = 0;
  let observedSameDay = 0;
  let observedAfterDay = 0;
  let backfill = 0;
  const projects: string[] = [];
  const runtimes: string[] = [];

  const narrative: StoredEvent[] = [];
  for (const event of input.events) {
    kindCounts[event.kind] = (kindCounts[event.kind] ?? 0) + 1;
    if (!event.occurredAt) occurredMissing++;
    if (!projects.includes(event.projectId)) projects.push(event.projectId);
    if (!runtimes.includes(event.runtime)) runtimes.push(event.runtime);
    if (isBackfill(event, input.lateObservedHours, window.endMs) && !input.includeBackfill) { backfill++; continue; }
    const observed = Date.parse(event.observedAt);
    if (Number.isFinite(observed) && observed < window.endMs) observedSameDay++;
    if (Number.isFinite(observed) && observed >= window.endMs) observedAfterDay++;
    narrative.push(event);
  }

  const bySession = new Map<string, StoredEvent[]>();
  for (const event of narrative) {
    if (!bySession.has(event.sessionKey)) bySession.set(event.sessionKey, []);
    bySession.get(event.sessionKey)!.push(event);
  }
  const sessions: SessionProjection[] = [];
  for (const [sessionKey, events] of bySession) {
    sessions.push(projectSession(sessionKey, events, input.sessionStarted.get(sessionKey),
      input.sessionTitles.get(sessionKey), input.lastUsage.get(sessionKey)));
  }
  sessions.sort((a, b) => {
    const left = a.started_at ? Date.parse(a.started_at) : 0;
    const right = b.started_at ? Date.parse(b.started_at) : 0;
    return left - right || a.project_id.localeCompare(b.project_id);
  });

  const projectedChars = sessions.reduce((sum, session) => sum + session.totals.projected_chars, 0);
  const projectedTokens = sessions.reduce((sum, session) => sum + session.totals.projected_tokens, 0);
  const cost = sessions.reduce((sum, session) => sum + (session.usage.cost_usd ?? 0), 0);
  const events = input.events.length;

  return {
    schema_version: 1,
    kind: 'journal.day-bundle',
    day: input.day,
    timezone: input.timeZone,
    window: { start: window.startIso, end: window.endIso, hours: window.hours },
    archive: { archive_id: input.archiveId, cursor: input.cursor, high_watermark: input.highWatermark },
    generated_at: input.now,
    coverage: {
      events_scanned: events,
      events_in_day: events,
      narrative_events: narrative.length,
      backfill_events: backfill,
      occurred_at_missing: occurredMissing,
      observed_same_day: observedSameDay,
      observed_after_day: observedAfterDay,
      late_observed_hours: input.lateObservedHours,
    },
    totals: {
      sessions: sessions.length,
      events,
      kind_counts: kindCounts,
      projected_chars: projectedChars,
      projected_tokens: projectedTokens,
      cost_usd_recorded: cost,
    },
    projects,
    runtimes,
    sessions,
  };
}

/** Hash of the inputs that determine the note; excludes generation timestamps. */
export function bundleInputHash(bundle: DayBundle): string {
  const canonical = {
    schema_version: bundle.schema_version,
    day: bundle.day,
    timezone: bundle.timezone,
    window: bundle.window,
    archive: { archive_id: bundle.archive.archive_id },
    projects: bundle.projects,
    runtimes: bundle.runtimes,
    sessions: bundle.sessions,
    totals: bundle.totals,
    coverage: {
      backfill_events: bundle.coverage.backfill_events,
      occurred_at_missing: bundle.coverage.occurred_at_missing,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
