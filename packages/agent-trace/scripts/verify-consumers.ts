/** Real archive + real consumer CLI integration, exclusively synthetic inputs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from '../src/store.ts';
import type { Batch } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const plugins = path.dirname(root.replace(/\/$/, ''));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'shared-agent-acceptance-'));
const statsDir = path.join(plugins, 'agent-stats');
const knowledgeDir = path.join(plugins, 'agent-knowledge');
const statsDb = path.join(temporary, 'stats.sqlite');
const config = path.join(temporary, 'agent-knowledge.json');
const selectedSource = path.join(temporary, 'selected.jsonl');
copyFileSync(path.join(root, 'fixtures/codex/demo.jsonl'), selectedSource);
mkdirSync(path.join(temporary, 'documents'));
writeFileSync(config, JSON.stringify({ schema_version: 1, database: './knowledge.sqlite', allowed_project_ids: ['demo'], sources: [{ id: 'docs', root: './documents', project_id: 'demo' }] }));
const archive = new Archive(path.join(temporary, 'archive.sqlite'), 'content');
const stats = (args: string[]): any => JSON.parse(execFileSync('python3', ['-m', 'agent_stats', '--db', statsDb, ...args], { cwd: statsDir, encoding: 'utf8' }));
const knowledge = (args: string[]): any => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/interfaces/cli.ts', ...args, '--config', config], { cwd: knowledgeDir, encoding: 'utf8' }));
let fileNumber = 0;
function consume(batch: Batch, target: 'stats' | 'knowledge'): any {
  const filename = path.join(temporary, `page-${fileNumber++}.json`);
  writeFileSync(filename, JSON.stringify(batch), { mode: 0o600 });
  return target === 'stats' ? stats(['import-archive', '--input', filename]) : knowledge(['archive-import', '--input', filename]);
}
try {
  const report = archive.importFile(selectedSource, 'acceptance-device', 'demo');
  assert.equal(report.imported, 11);
  assert.equal(archive.importFile(selectedSource, 'acceptance-device', 'demo').imported, 0);
  let statsCursor = 0, knowledgeCursor = 0;
  // Different page sizes prove consumer cursors and persistence are independent.
  let more = true;
  while (more) {
    const batch = archive.exportBatch(statsCursor, 3, 'metadata');
    const result = consume(batch, 'stats');
    statsCursor = result.cursor; more = batch.has_more;
    assert.equal(consume(batch, 'stats').replayed, true);
  }
  more = true;
  while (more) {
    const batch = archive.exportBatch(knowledgeCursor, 4, 'content');
    const result = consume(batch, 'knowledge');
    knowledgeCursor = result.cursor; more = batch.has_more;
    assert.equal(consume(batch, 'knowledge').replayed, true);
  }
  unlinkSync(selectedSource);
  const summary = stats(['summary']).summary;
  assert.equal(summary.sessions, 1); assert.equal(summary.turns, 1);
  assert.equal(summary.token_total, 140); assert.equal(summary.tool_calls, 1);
  assert.doesNotMatch(readFileSync(statsDb).toString(), /SYNTHETIC_PRIVATE|SYNTHETIC_FUTURE/);
  const found = knowledge(['archive-search', '--query', '幂等键', '--project', 'demo']).evidence;
  assert.ok(found.length > 0);
  const reference = found[0];
  const evidence = knowledge(['archive-read', '--archive', reference.archive_id, '--event', reference.event.event_id, '--project', 'demo']);
  assert.ok(evidence.event.source.record_hash);
  assert.equal(knowledge(['search', '--query', '幂等键', '--project', 'demo']).results.length, 0);
  archive.deleteSession('codex', 'acceptance-device', 'archive-demo-session');
  statsCursor = consume(archive.exportBatch(statsCursor, 100, 'metadata'), 'stats').cursor;
  knowledgeCursor = consume(archive.exportBatch(knowledgeCursor, 100, 'content'), 'knowledge').cursor;
  assert.equal(stats(['summary']).summary.sessions, 0);
  assert.equal(knowledge(['archive-search', '--query', '幂等键', '--project', 'demo']).evidence.length, 0);
  assert.equal(statsCursor, knowledgeCursor);

  // Real normalizers -> metadata export -> Python projection. These are source
  // records, not an asserted inventory of all provider requests.
  for (const runtime of ['pi', 'dsh'] as const) {
    const filename = path.join(temporary, `${runtime}-sparse.jsonl`);
    const at = (n: number) => `2026-01-02T10:00:0${n}.000Z`;
    const rows = runtime === 'pi' ? [
      { type: 'session', id: 'pi-sparse', timestamp: at(0), cwd: '/synthetic' },
      { type: 'message', id: 'u', timestamp: at(1), message: { role: 'user', content: 'Synthetic task' } },
      { type: 'message', id: '\u0085a1', timestamp: at(2), message: { role: 'assistant', model: 'gpt-6.1-sol', stopReason: 'toolUse',
        usage: { input: 80, cacheRead: 20, output: 10, totalTokens: 110, cost: { total: 0.02, totalFromProvider: true } } } },
      { type: 'message', id: '\ufeffa2', timestamp: at(3), message: { role: 'assistant', model: 'gpt-6.1-sol', stopReason: 'stop',
        usage: { input: 50, output: 5, totalTokens: 55 } } },
    ] : [
      { type: 'session', version: 4, id: 'dsh-sparse', createdAt: Date.parse(at(0)), cwd: '/synthetic' },
      { type: 'turn/start', seq: 1, time: Date.parse(at(1)), data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time: Date.parse(at(2)), data: { turn: 1,
        message: { source: { model: 'gpt-6.1-sol' }, content: [] },
        usage: { inputTokens: 80, cacheReadTokens: 20, outputTokens: 10, totalTokens: 110 } } },
      { type: 'assistant/message', seq: 3, time: Date.parse(at(3)), data: { turn: 1, message: { content: [] } } },
      { type: 'turn/end', seq: 4, time: Date.parse(at(4)), data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    writeFileSync(filename, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    archive.importFile(filename, 'acceptance-device', 'demo');
    const batch = archive.exportBatch(statsCursor, 100, 'metadata');
    const usageRecords = batch.events.filter(event => event.kind === 'usage.snapshot');
    assert.equal(usageRecords.length, 2);
    assert.ok(usageRecords.every(event => event.data.usage_basis === 'request'));
    assert.equal(new Set(usageRecords.map(event => event.data.request_id)).size, 2);
    if (runtime === 'pi') {
      assert.equal(usageRecords[0]!.data.request_id, '\u0085a1');
      assert.equal(usageRecords[0]!.data.request_id_source, 'pi_entry');
      assert.equal(usageRecords[1]!.data.request_id, null);
      assert.equal(usageRecords[1]!.data.request_id_source, 'source_record');
    }
    statsCursor = consume(batch, 'stats').cursor;
    assert.equal(consume(batch, 'stats').replayed, true);
    knowledgeCursor = consume(archive.exportBatch(knowledgeCursor, 100, 'content'), 'knowledge').cursor;
    const data = stats(['summary']);
    const turn = data.turns[0];
    assert.equal(data.summary.request_coverage.total_requests, null);
    assert.equal(data.summary.request_coverage.cost_ratio, null);
    assert.equal(data.summary.request_coverage.observed_records, 2);
    assert.equal(turn.cached_input_tokens, null);
    assert.equal(turn.usage_known.cached_input_tokens, 20);
    assert.equal(data.summary.estimated_cost, null);
    if (runtime === 'pi') {
      assert.equal(data.summary.estimated_cost_known, 0.02);
      assert.equal(data.summary.recorded_cost, null);
      assert.equal(turn.recorded_cost_known_usd, 0.02);
      assert.equal(turn.token_total, 165);
    } else {
      assert.equal(turn.token_total, null);
      assert.equal(data.summary.token_known, 110);
      assert.equal(data.summary.request_coverage.unknown_usage_records, 1);
      assert.equal(data.summary.recorded_cost_known, null);
      assert.ok(data.summary.estimated_cost_known > 0);
    }
    archive.deleteSession(runtime, 'acceptance-device', `${runtime}-sparse`);
    statsCursor = consume(archive.exportBatch(statsCursor, 100, 'metadata'), 'stats').cursor;
    knowledgeCursor = consume(archive.exportBatch(knowledgeCursor, 100, 'content'), 'knowledge').cursor;
    assert.equal(stats(['summary']).summary.sessions, 0);
  }
  process.stdout.write(JSON.stringify({ passed: true, synthetic_only: true, imported_events: report.imported,
    before_delete: { sessions: summary.sessions, turns: summary.turns, token_total: summary.token_total, tool_calls: summary.tool_calls },
    independent_cursors: true, duplicate_pages: true, evidence_after_source_removal: true, statistics_metadata_only: true,
    evidence_separate_from_confirmed_knowledge: true, deletion_propagated: true,
    sparse_pi_dsh_usage: true, request_coverage_unknown: true }) + '\n');
} finally { archive.close(); rmSync(temporary, { recursive: true, force: true }); }
