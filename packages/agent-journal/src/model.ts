import type { JournalConfig } from './config.ts';
import { JournalError } from './errors.ts';
import type { DayBundle, SessionProjection } from './projection.ts';
import { estimateTokens } from './projection.ts';
import type { ChatMessage, ChatProvider, ChatUsage } from './provider.ts';

export const PROMPT_VERSION = 1;
const MAP_BATCH_TOKENS = 6_000;
const MAX_SESSION_INPUT_TOKENS = 8_000;
const MAX_PROJECTS = 20;
const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 1_200;

export interface SessionNote {
  session_key: string;
  summary: string;
  decisions: string[];
  follow_ups: string[];
}

export interface ProjectSummary {
  project_id: string;
  summary: string;
}

export interface DayReport {
  schema_version: 1;
  day: string;
  highlights: string[];
  projects: ProjectSummary[];
  decisions: string[];
  blockers: string[];
  next_steps: string[];
  session_notes: SessionNote[];
  dropped_sessions: number;
}

export interface UsageTotals {
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  missing_usage_calls: number;
}

export interface SummarizeResult {
  report: DayReport;
  usage: UsageTotals;
}

function invalid(message: string): never {
  throw new JournalError('MODEL_OUTPUT', 'permanent', message);
}

function parseJsonContent(content: string, phase: string, finishReason: string | null): unknown {
  if (finishReason === 'length') {
    invalid(`${phase} output was truncated (finish_reason=length); raise model.max_output_tokens or reduce the batch size`);
  }
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) invalid(`${phase} output is not a JSON object (finish_reason=${finishReason ?? 'unknown'}, length=${content.length})`);
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    invalid(`${phase} output is not valid JSON (finish_reason=${finishReason ?? 'unknown'}, length=${content.length}, head=${JSON.stringify(content.slice(0, 120))}, tail=${JSON.stringify(content.slice(-120))})`);
  }
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  // Long lists are truncated rather than rejected: the model cannot be trusted
  // to respect a cosmetic count, and a valid report is still useful.
  return value.slice(0, MAX_ITEMS).map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) invalid(`${field} contains a non-string item`);
    return entry.trim().slice(0, MAX_ITEM_CHARS);
  });
}

function summaryText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim().slice(0, MAX_ITEM_CHARS);
}

function sessionPayload(session: SessionProjection): Record<string, unknown> {
  const payload = {
    session_key: session.session_key,
    project_id: session.project_id,
    runtime: session.runtime,
    title: session.title,
    started_at: session.started_at,
    ended_at: session.ended_at,
    open_ended: session.open_ended,
    counts: {
      events: session.counts.events,
      user_messages: session.counts.user,
      answers: session.counts.answers,
      tools: session.counts.tools,
      interrupted: session.counts.interrupted,
      unknown: session.counts.unknown,
    },
    user_messages: session.user_messages.map((message) => ({ at: message.at, title: message.title, text: message.text })),
    answers: [...session.final_answers, ...session.fallback_answers].map((answer) => answer.text),
    tools: session.tool_counts,
    paths: session.touched_paths.slice(0, 20),
    cost_usd: session.usage.cost_usd,
  };
  // A single session should never blow the prompt by itself; trim the text
  // fields until the payload fits the per-session allowance.
  let encoded = JSON.stringify(payload);
  if (estimateTokens(encoded) > MAX_SESSION_INPUT_TOKENS) {
    payload.user_messages = payload.user_messages.slice(0, 4).map((message) => ({ ...message, text: message.text.slice(0, 600) }));
    payload.answers = payload.answers.slice(0, 3).map((answer) => answer.slice(0, 800));
    encoded = JSON.stringify(payload);
  }
  return payload;
}

function sessionTokens(session: SessionProjection): number {
  return estimateTokens(JSON.stringify(sessionPayload(session)));
}

function selectSessions(bundle: DayBundle, maxInputTokens: number): { selected: SessionProjection[]; dropped: number } {
  const reserve = 4_000; // reduce prompt + system prompts
  const mapBudget = Math.max(1_000, maxInputTokens - reserve);
  const withTokens = bundle.sessions.map((session) => ({ session, tokens: sessionTokens(session) }));
  const total = withTokens.reduce((sum, entry) => sum + entry.tokens, 0);
  if (total <= mapBudget) return { selected: bundle.sessions, dropped: 0 };
  const ordered = [...withTokens].sort((a, b) => b.tokens - a.tokens);
  const selectedKeys = new Set<string>();
  let used = 0;
  for (const entry of ordered) {
    if (used + entry.tokens > mapBudget) continue;
    selectedKeys.add(entry.session.session_key);
    used += entry.tokens;
  }
  const selected = bundle.sessions.filter((session) => selectedKeys.has(session.session_key));
  return { selected, dropped: bundle.sessions.length - selected.length };
}

function batches(sessions: SessionProjection[]): SessionProjection[][] {
  const result: SessionProjection[][] = [];
  let current: SessionProjection[] = [];
  let tokens = 0;
  for (const session of sessions) {
    const cost = sessionTokens(session);
    if (current.length && tokens + cost > MAP_BATCH_TOKENS) {
      result.push(current);
      current = [];
      tokens = 0;
    }
    current.push(session);
    tokens += cost;
  }
  if (current.length) result.push(current);
  return result;
}

function mapMessages(day: string, timezone: string, sessions: SessionProjection[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You summarize coding-agent work sessions for a personal daily review.',
        'Use only the supplied JSON. Do not invent files, commands, results, decisions or outcomes.',
        'If evidence is insufficient, say so briefly instead of guessing.',
        'Write in the language used in the developer requests (usually Chinese).',
        'Return ONLY valid JSON with this shape:',
        '{"sessions":[{"session_key":"exact key","summary":"1-3 sentences","decisions":["explicit decisions"],"follow_ups":["open threads"]}]}',
        'Keep each summary under 120 Chinese characters or 60 English words.',
        'decisions must be explicit choices or confirmations, not inferred; follow_ups only for unfinished work.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({ day, timezone, sessions: sessions.map(sessionPayload) }),
    },
  ];
}

function reduceMessages(bundle: DayBundle, notes: SessionNote[]): ChatMessage[] {
  const projectStats = bundle.projects.map((project) => {
    const sessions = bundle.sessions.filter((session) => session.project_id === project);
    return {
      project_id: project,
      sessions: sessions.length,
      events: sessions.reduce((sum, session) => sum + session.counts.events, 0),
      tools: sessions.reduce((sum, session) => sum + session.counts.tools, 0),
      cost_usd: sessions.reduce((sum, session) => sum + (session.usage.cost_usd ?? 0), 0),
    };
  });
  return [
    {
      role: 'system',
      content: [
        'You write the daily review for a developer who worked with coding agents.',
        'Use only the supplied session digests and statistics; never invent evidence.',
        'Write in the language used in the developer requests (usually Chinese).',
        'Return ONLY valid JSON with this shape:',
        '{"highlights":["3-6 concrete things done"],"projects":[{"project_id":"exact id","summary":"one paragraph"}],"decisions":["explicit decisions"],"blockers":["open problems"],"next_steps":["suggested follow-ups"],"session_notes":[{"session_key":"exact key","summary":"short note"}]}',
        'highlights should describe outcomes, not process. decisions must be explicit. blockers only for unresolved issues. next_steps can be suggestions but must follow from open threads.',
        'Every project_id and session_key must come from the supplied data.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        day: bundle.day,
        timezone: bundle.timezone,
        totals: {
          sessions: bundle.totals.sessions,
          events: bundle.totals.events,
          projects: bundle.projects.length,
          projected_tokens: bundle.totals.projected_tokens,
        },
        project_stats: projectStats,
        session_digests: notes.map((note) => ({
          session_key: note.session_key,
          summary: note.summary,
          decisions: note.decisions,
          follow_ups: note.follow_ups,
        })),
      }),
    },
  ];
}

function validateMap(value: unknown, expectedKeys: Set<string>): SessionNote[] {
  const object = value as Record<string, unknown>;
  if (!object || typeof object !== 'object' || !Array.isArray(object.sessions)) invalid('Map output must contain a sessions array');
  const notes: SessionNote[] = [];
  const seen = new Set<string>();
  for (const entry of object.sessions) {
    if (!entry || typeof entry !== 'object') invalid('Map session entry must be an object');
    const item = entry as Record<string, unknown>;
    const sessionKey = item.session_key;
    if (typeof sessionKey !== 'string' || !expectedKeys.has(sessionKey)) invalid('Map output contains an unknown session_key');
    if (seen.has(sessionKey)) invalid('Map output contains a duplicate session_key');
    seen.add(sessionKey);
    notes.push({
      session_key: sessionKey,
      summary: summaryText(item.summary, 'map.summary'),
      decisions: item.decisions === undefined ? [] : strings(item.decisions, 'map.decisions'),
      follow_ups: item.follow_ups === undefined ? [] : strings(item.follow_ups, 'map.follow_ups'),
    });
  }
  return notes;
}

function validateReduce(value: unknown, bundle: DayBundle, fallback: SessionNote[]): DayReport {
  const object = value as Record<string, unknown>;
  if (!object || typeof object !== 'object') invalid('Reduce output must be an object');
  const projectIds = new Set(bundle.projects);
  const sessionKeys = new Set(bundle.sessions.map((session) => session.session_key));
  const projectsRaw = object.projects;
  if (!Array.isArray(projectsRaw) || projectsRaw.length > MAX_PROJECTS) invalid('Reduce output must contain a projects array');
  const projects: ProjectSummary[] = projectsRaw.map((entry) => {
    if (!entry || typeof entry !== 'object') invalid('Reduce project entry must be an object');
    const item = entry as Record<string, unknown>;
    if (typeof item.project_id !== 'string' || !projectIds.has(item.project_id)) invalid('Reduce output contains an unknown project_id');
    return { project_id: item.project_id, summary: summaryText(item.summary, 'reduce.project.summary') };
  });

  const sessionNotes: SessionNote[] = [];
  const seen = new Set<string>();
  if (object.session_notes !== undefined) {
    if (!Array.isArray(object.session_notes)) invalid('Reduce session_notes must be an array');
    for (const entry of object.session_notes) {
      if (!entry || typeof entry !== 'object') invalid('Reduce session note must be an object');
      const item = entry as Record<string, unknown>;
      if (typeof item.session_key !== 'string' || !sessionKeys.has(item.session_key)) invalid('Reduce output contains an unknown session_key');
      if (seen.has(item.session_key)) continue;
      seen.add(item.session_key);
      sessionNotes.push({
        session_key: item.session_key,
        summary: summaryText(item.summary, 'reduce.session.summary'),
        decisions: item.decisions === undefined ? [] : strings(item.decisions, 'reduce.session.decisions'),
        follow_ups: item.follow_ups === undefined ? [] : strings(item.follow_ups, 'reduce.session.follow_ups'),
      });
    }
  }
  for (const note of fallback) if (!seen.has(note.session_key)) sessionNotes.push(note);

  return {
    schema_version: 1,
    day: bundle.day,
    highlights: strings(object.highlights, 'reduce.highlights'),
    projects,
    decisions: object.decisions === undefined ? [] : strings(object.decisions, 'reduce.decisions'),
    blockers: object.blockers === undefined ? [] : strings(object.blockers, 'reduce.blockers'),
    next_steps: object.next_steps === undefined ? [] : strings(object.next_steps, 'reduce.next_steps'),
    session_notes: sessionNotes,
    dropped_sessions: 0,
  };
}

function addUsage(totals: UsageTotals, usage: ChatUsage): void {
  totals.calls++;
  if (usage.input_tokens === null) {
    totals.missing_usage_calls++;
    totals.input_tokens = null;
  } else if (totals.input_tokens !== null) {
    totals.input_tokens += usage.input_tokens;
  }
  if (usage.output_tokens === null) totals.output_tokens = null;
  else if (totals.output_tokens !== null) totals.output_tokens += usage.output_tokens;
  if (usage.total_tokens === null) totals.total_tokens = null;
  else if (totals.total_tokens !== null) totals.total_tokens += usage.total_tokens;
}

/** Two-stage map/reduce summary. All provider calls go through one injected
 * ChatProvider so tests can use a deterministic fake. */
export async function summarizeDay(config: JournalConfig, bundle: DayBundle, provider: ChatProvider): Promise<SummarizeResult> {
  if (!config.model) throw new JournalError('MODEL_NOT_CONFIGURED', 'config', 'config.model is required for model summarization');
  if (!bundle.sessions.length) {
    return {
      report: {
        schema_version: 1, day: bundle.day, highlights: [], projects: [], decisions: [], blockers: [],
        next_steps: [], session_notes: [], dropped_sessions: 0,
      },
      usage: { calls: 0, input_tokens: null, output_tokens: null, total_tokens: null, estimated_input_tokens: 0, estimated_output_tokens: 0, missing_usage_calls: 0 },
    };
  }

  const { selected, dropped } = selectSessions(bundle, config.budget.maxInputTokensPerDay);
  const usage: UsageTotals = {
    calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0,
    estimated_input_tokens: 0, estimated_output_tokens: 0, missing_usage_calls: 0,
  };
  const notes: SessionNote[] = [];
  for (const group of batches(selected)) {
    const messages = mapMessages(bundle.day, bundle.timezone, group);
    usage.estimated_input_tokens += estimateTokens(messages.map((message) => message.content).join('\n'));
    const result = await provider.complete(messages, { maxOutputTokens: config.model.maxOutputTokens });
    usage.estimated_output_tokens += estimateTokens(result.content);
    addUsage(usage, result.usage);
    const expected = new Set(group.map((session) => session.session_key));
    notes.push(...validateMap(parseJsonContent(result.content, 'map', result.finishReason), expected));
  }

  // Fill sessions the map stage omitted so the daily note never silently loses
  // a session. They are labelled as missing instead of being invented.
  const covered = new Set(notes.map((note) => note.session_key));
  for (const session of selected) {
    if (covered.has(session.session_key)) continue;
    notes.push({ session_key: session.session_key, summary: '（模型未返回该会话摘要）', decisions: [], follow_ups: [] });
  }

  const reducePrompt = reduceMessages(bundle, notes);
  usage.estimated_input_tokens += estimateTokens(reducePrompt.map((message) => message.content).join('\n'));
  const reduced = await provider.complete(reducePrompt, { maxOutputTokens: config.model.maxOutputTokens });
  usage.estimated_output_tokens += estimateTokens(reduced.content);
  addUsage(usage, reduced.usage);
  const report = validateReduce(parseJsonContent(reduced.content, 'reduce', reduced.finishReason), bundle, notes);
  report.dropped_sessions = dropped;

  if (usage.missing_usage_calls > 0) {
    usage.input_tokens = null;
    usage.output_tokens = null;
    usage.total_tokens = null;
  }
  return { report, usage };
}
