import test from 'node:test';
import assert from 'node:assert/strict';
import { compactEvent, type StoredEvent } from '../src/events.ts';
import { JournalError } from '../src/errors.ts';
import { buildDayBundle, type DayBundle } from '../src/projection.ts';
import { summarizeDay, PROMPT_VERSION } from '../src/model.ts';
import { codexEvent, configFor } from './helpers.ts';
import { DynamicProvider, ScriptedProvider } from './fake-provider.ts';

const ARCHIVE = 'fixture-archive-0001';
const DAY = '2026-01-01';

function session(id: string, title: string, user: string, answer: string, seqBase: number): StoredEvent[] {
  return [
    compactEvent(ARCHIVE, codexEvent({ seq: seqBase, sessionId: id, kind: 'session.started', data: { title }, occurredAt: '2026-01-01T00:00:00.000Z' })),
    compactEvent(ARCHIVE, codexEvent({ seq: seqBase + 1, sessionId: id, kind: 'message.user', body: { text: user }, occurredAt: '2026-01-01T00:00:01.000Z' })),
    compactEvent(ARCHIVE, codexEvent({ seq: seqBase + 2, sessionId: id, kind: 'turn.completed', body: { text: answer }, occurredAt: '2026-01-01T00:00:02.000Z' })),
  ];
}

function bundleOf(sessions: StoredEvent[][]): DayBundle {
  const events = sessions.flat();
  const started = new Map<string, StoredEvent>();
  for (const event of events) if (event.kind === 'session.started') started.set(event.sessionKey, event);
  return buildDayBundle({
    day: DAY,
    timeZone: 'Asia/Shanghai',
    events,
    sessionStarted: started,
    lastUsage: new Map(),
    archiveId: ARCHIVE,
    cursor: 99,
    highWatermark: 99,
    lateObservedHours: 36,
    includeBackfill: true,
    now: '2026-01-02T00:00:00.000Z',
  });
}

function configWithModel() {
  return configFor('http://127.0.0.1:9', {
    projects: ['fixture'],
    model: {
      provider: 'openai-compatible', base_url: 'https://api.example.com/v1', model: 'fake-model',
      api_key_env: 'JOURNAL_FAKE_KEY', timeout_seconds: 10, max_output_tokens: 500,
    },
  });
}

test('map/reduce produces a validated report with usage', async () => {
  const bundle = bundleOf([
    session('11111111-2222-4333-8444-555555555555', 'Session A', 'build feature A', 'done A', 1),
    session('22222222-3333-4444-8555-666666666666', 'Session B', 'build feature B', 'done B', 10),
  ]);
  const provider = new DynamicProvider();
  const result = await summarizeDay(configWithModel(), bundle, provider);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]?.phase, 'map');
  assert.equal(provider.calls[1]?.phase, 'reduce');
  assert.deepEqual(result.report.highlights, ['fake highlight']);
  assert.equal(result.report.projects.length, 1);
  assert.equal(result.report.session_notes.length, 2);
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.input_tokens, 200);
  assert.equal(result.usage.output_tokens, 40);
  assert.equal(result.report.dropped_sessions, 0);
  assert.ok(result.usage.estimated_input_tokens > 0);
  assert.equal(PROMPT_VERSION, 1);
});

test('invalid map output is rejected', async () => {
  const bundle = bundleOf([session('11111111-2222-4333-8444-555555555555', 'Session A', 'u', 'a', 1)]);
  const provider = new ScriptedProvider(['not json']);
  await assert.rejects(() => summarizeDay(configWithModel(), bundle, provider),
    (error: unknown) => error instanceof JournalError && error.code === 'MODEL_OUTPUT');
});

test('invalid reduce output and unknown references are rejected', async () => {
  const bundle = bundleOf([session('11111111-2222-4333-8444-555555555555', 'Session A', 'u', 'a', 1)]);
  const key = bundle.sessions[0]!.session_key;
  const goodMap = JSON.stringify({ sessions: [{ session_key: key, summary: 'ok', decisions: [], follow_ups: [] }] });
  const unknownSession = JSON.stringify({
    highlights: ['x'], projects: [{ project_id: 'fixture', summary: 'p' }],
    decisions: [], blockers: [], next_steps: [],
    session_notes: [{ session_key: 'unknown-session', summary: 'x' }],
  });
  await assert.rejects(() => summarizeDay(configWithModel(), bundle, new ScriptedProvider([goodMap, unknownSession])),
    (error: unknown) => error instanceof JournalError && error.code === 'MODEL_OUTPUT');

  const unknownProject = JSON.stringify({
    highlights: ['x'], projects: [{ project_id: 'other-project', summary: 'p' }],
    decisions: [], blockers: [], next_steps: [], session_notes: [],
  });
  await assert.rejects(() => summarizeDay(configWithModel(), bundle, new ScriptedProvider([goodMap, unknownProject])),
    (error: unknown) => error instanceof JournalError && error.code === 'MODEL_OUTPUT');
});

test('token budget drops lowest-priority sessions instead of overflowing', async () => {
  const sessions: StoredEvent[][] = [];
  for (let index = 0; index < 20; index++) {
    const id = `session-${String(index).padStart(4, '0')}`;
    sessions.push(session(id, `Session ${index}`, `request ${index}`, `answer ${index}`, index * 10 + 1));
  }
  const config = configWithModel();
  config.budget = { maxInputTokensPerDay: 1_000, maxOutputTokensPerDay: 10_000 };
  const provider = new DynamicProvider();
  const result = await summarizeDay(config, bundleOf(sessions), provider);
  assert.ok(result.report.dropped_sessions > 0);
  assert.ok(provider.calls.length >= 2);
});
