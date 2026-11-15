import test from 'node:test';
import assert from 'node:assert/strict';
import { compactEvent, type StoredEvent } from '../src/events.ts';
import { buildDayBundle, bundleInputHash, type DayBundle } from '../src/projection.ts';
import { renderDeterministic } from '../src/render.ts';
import { codexEvent } from './helpers.ts';

const ARCHIVE = 'fixture-archive-0001';
const SESSION = '11111111-2222-4333-8444-555555555555';

function stored(overrides: Parameters<typeof codexEvent>[0]): StoredEvent {
  return compactEvent(ARCHIVE, codexEvent(overrides));
}

function sessionKey(): string {
  return JSON.stringify(['codex', 'fixture-device', SESSION]);
}

function build(events: StoredEvent[], options: { includeBackfill?: boolean; lastUsage?: StoredEvent | null; sessionTitles?: Map<string, string> } = {}): DayBundle {
  const key = sessionKey();
  const started = events.find((event) => event.kind === 'session.started');
  return buildDayBundle({
    day: '2026-01-01',
    timeZone: 'Asia/Shanghai',
    events,
    sessionStarted: new Map(key && started ? [[key, started]] : []),
    sessionTitles: options.sessionTitles ?? new Map(),
    lastUsage: new Map([[key, options.lastUsage ?? null]]),
    archiveId: ARCHIVE,
    cursor: 6,
    highWatermark: 6,
    lateObservedHours: 36,
    includeBackfill: options.includeBackfill ?? true,
    now: '2026-01-02T00:00:00.000Z',
  });
}

function baseline(): StoredEvent[] {
  return [
    stored({ seq: 1, kind: 'session.started', data: { cwd: '/workspace/fixture', title: 'Fixture session' }, occurredAt: '2026-01-01T00:00:00.000Z' }),
    stored({ seq: 2, kind: 'message.user', data: { title: 'Say hello' }, body: { text: 'Hello, run the fixture.' }, occurredAt: '2026-01-01T00:00:01.000Z' }),
    stored({ seq: 3, kind: 'tool.called', data: { name: 'exec', call_id: 'c1', input_bytes: 10 }, body: { arguments: { file_path: '/Users/example/project/src/a.ts' } }, occurredAt: '2026-01-01T00:00:02.000Z' }),
    stored({ seq: 4, kind: 'tool.returned', data: { call_id: 'c1', output_bytes: 6, status: 'result_observed' }, body: { output: 'SECRET TOOL OUTPUT' }, occurredAt: '2026-01-01T00:00:03.000Z' }),
    stored({ seq: 5, kind: 'usage.snapshot', data: { cumulative: { input_tokens: 1200, output_tokens: 120 }, last_usage: { input_tokens: 1200, output_tokens: 120 }, cost_usd: 0.01, cost_source: 'model_rates' }, occurredAt: '2026-01-01T00:00:04.000Z' }),
    stored({ seq: 6, kind: 'turn.completed', body: { text: 'fixture completed' }, occurredAt: '2026-01-01T00:00:05.000Z' }),
  ];
}

test('projects one session into a bounded, source-backed bundle', () => {
  const events = baseline();
  const bundle = build(events, { lastUsage: events.find((event) => event.kind === 'usage.snapshot') });
  assert.equal(bundle.sessions.length, 1);
  const session = bundle.sessions[0]!;
  assert.equal(session.title, 'Fixture session');
  assert.equal(session.user_messages[0]?.text, 'Hello, run the fixture.');
  assert.equal(session.final_answers[0]?.text, 'fixture completed');
  assert.equal(session.tool_counts.exec, 1);
  assert.deepEqual(session.touched_paths, ['/Users/example/project/src/a.ts']);
  assert.equal(session.usage.cost_usd, 0.01);
  assert.equal(session.counts.events, 6);
  assert.equal(session.open_ended, false);
  assert.ok(session.totals.projected_tokens > 0);
  assert.ok(bundleInputHash(bundle).length === 64);
});

test('tool outputs never enter the projection or the rendered note', () => {
  const bundle = build(baseline());
  const markdown = renderDeterministic(bundle);
  assert.equal(JSON.stringify(bundle).includes('SECRET TOOL OUTPUT'), false);
  assert.equal(markdown.includes('SECRET TOOL OUTPUT'), false);
  assert.equal(markdown.includes('generated: false'), true);
  assert.equal(markdown.includes('# 2026-01-01'), true);
  assert.equal(markdown.includes('Fixture session'), true);
  assert.equal(markdown.includes('fixture completed'), true);
});

test('instruction-like user messages are filtered but counted', () => {
  const events = [
    ...baseline(),
    stored({ seq: 7, kind: 'message.user', body: { text: '# AGENTS.md instructions\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>' }, occurredAt: '2026-01-01T00:00:06.000Z' }),
  ];
  const bundle = build(events);
  const session = bundle.sessions[0]!;
  assert.equal(session.counts.instruction_like, 1);
  assert.equal(session.user_messages.length, 1);
});

test('pi/dsh style sessions fall back to assistant answers', () => {
  const events = [
    stored({ seq: 1, kind: 'session.started', data: { title: 'Fallback session' } }),
    stored({ seq: 2, kind: 'message.user', body: { text: 'Do the thing' } }),
    stored({ seq: 3, kind: 'message.assistant', body: { text: 'final assistant answer' } }),
  ];
  const bundle = build(events);
  const session = bundle.sessions[0]!;
  assert.equal(session.final_answers.length, 0);
  assert.equal(session.fallback_answers.length, 1);
  assert.equal(session.counts.answers, 1);
  assert.equal(session.open_ended, false);
});

test('a later session.title revision replaces the started snapshot', () => {
  const events = baseline();
  events.push(stored({
    seq: 7, kind: 'session.title', data: { title: 'Model given name' },
    occurredAt: '2026-01-01T00:00:06.000Z',
  }));
  const bundle = build(events, { sessionTitles: new Map([[sessionKey(), 'Model given name']]) });
  assert.equal(bundle.sessions[0]!.title, 'Model given name');
  assert.match(renderDeterministic(bundle), /Model given name/);
  // A bundle hash changes when the display name changes, so a late revision
  // invalidates an already generated report instead of silently keeping it.
  const before = build(baseline());
  assert.notEqual(bundleInputHash(bundle), bundleInputHash(before));
});

test('late observed history is excluded unless backfill is explicitly included', () => {
  const events = [
    stored({ seq: 1, kind: 'message.user', body: { text: 'old backfilled request' }, occurredAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-03T00:00:00.000Z' }),
  ];
  const excluded = build(events, { includeBackfill: false });
  assert.equal(excluded.coverage.backfill_events, 1);
  assert.equal(excluded.sessions.length, 0);
  const included = build(events, { includeBackfill: true });
  assert.equal(included.coverage.backfill_events, 0);
  assert.equal(included.sessions.length, 1);
});

test('user message and final answer caps are enforced', () => {
  const events = [stored({ seq: 1, kind: 'session.started', data: { title: 'Caps' } })];
  for (let index = 0; index < 25; index++) {
    events.push(stored({ seq: 2 + index, kind: 'message.user', body: { text: `message ${index}` } }));
  }
  for (let index = 0; index < 10; index++) {
    events.push(stored({ seq: 100 + index, kind: 'turn.completed', body: { text: `answer ${index}` } }));
  }
  const session = build(events).sessions[0]!;
  assert.equal(session.user_messages.length, 20);
  assert.equal(session.final_answers.length, 8);
});
