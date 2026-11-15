import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JournalConfig } from './config.ts';
import { JournalError } from './errors.ts';
import { assertLocalDay, isDayComplete, localDayWindow } from './day.ts';
import { summarizeDay, PROMPT_VERSION, type UsageTotals } from './model.ts';
import { buildDayBundle, bundleInputHash } from './projection.ts';
import { renderDeterministic, renderModelReport } from './render.ts';
import { createOpenAiCompatibleProvider, type ChatProvider } from './provider.ts';
import type { JournalStore } from './store.ts';

export interface DreamOptions {
  today?: boolean;
  force?: boolean;
  includeBackfill?: boolean;
  useModel?: boolean;
  provider?: ChatProvider;
  now?: number;
  highWatermark?: number | null;
}

export interface DreamResult {
  day: string;
  status: 'written' | 'skipped' | 'preview';
  revision: number;
  sessions: number;
  events: number;
  projected_tokens: number;
  cost_usd: number | null;
  input_hash: string;
  output_path: string;
  output_sha256: string | null;
  coverage: { backfill_events: number; occurred_at_missing: number };
  model: string | null;
  prompt_version: number | null;
  dropped_sessions: number | null;
  usage: UsageTotals | null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(filePath: string): string | null {
  try { return sha256(readFileSync(filePath)); } catch { return null; }
}

function writeNote(outputPath: string, content: string): void {
  mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
}

/**
 * Build one daily note. With `config.model` (and without `--no-model`) this runs
 * a map/reduce model summary; otherwise it writes the deterministic skeleton.
 */
export async function dreamDay(
  config: JournalConfig,
  store: JournalStore,
  day: string,
  options: DreamOptions = {},
): Promise<DreamResult> {
  assertLocalDay(day);
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const today = options.today === true;
  if (!today && !isDayComplete(day, config.timezone, config.finalize.graceHours, now)) {
    throw new JournalError('DAY_NOT_READY', 'permanent',
      `Day ${day} has not reached its ${config.finalize.graceHours}h grace window in ${config.timezone}`);
  }

  const useModel = config.model !== null && options.useModel !== false;
  const modelLabel = useModel ? config.model!.model : null;
  const promptVersion = useModel ? PROMPT_VERSION : null;

  const window = localDayWindow(day, config.timezone);
  const state = store.state();
  const events = store.eventsForDay(window.startIso, window.endIso);
  const sessionKeys = [...new Set(events.map((event) => event.sessionKey))];
  const started = store.sessionStartedFor(sessionKeys);
  const titles = store.latestTitlesFor(sessionKeys);
  const lastUsage = new Map(sessionKeys.map((sessionKey) => [sessionKey, store.lastUsageFor(sessionKey, window.endIso)]));

  const bundle = buildDayBundle({
    day,
    timeZone: config.timezone,
    events,
    sessionStarted: started,
    sessionTitles: titles,
    lastUsage,
    archiveId: state.archiveId,
    cursor: state.cursor,
    highWatermark: options.highWatermark ?? null,
    lateObservedHours: config.finalize.lateObservedHours,
    includeBackfill: options.includeBackfill === true,
    now: nowIso,
  });
  const baseHash = bundleInputHash(bundle);
  const inputHash = useModel
    ? sha256(JSON.stringify({ base: baseHash, model: modelLabel, prompt_version: promptVersion }))
    : baseHash;

  const outputDirectory = today ? path.join(config.outputDirectory, 'preview') : config.outputDirectory;
  const outputPath = path.join(outputDirectory, `${day}.md`);
  const existing = store.getDay(day);
  const runId = randomBytes(16).toString('hex');

  if (!today && options.force !== true && existing
    && existing.status === 'final'
    && existing.inputHash === inputHash
    && existing.outputPath === outputPath
    && existsSync(outputPath)
    && fileSha256(outputPath) === existing.outputHash) {
    store.insertRun({
      runId, day, model: modelLabel, promptVersion,
      inputHash, status: 'skipped', outputPath, outputHash: existing.outputHash, cost: null, createdAt: nowIso,
    });
    return {
      day,
      status: 'skipped',
      revision: existing.revision,
      sessions: bundle.totals.sessions,
      events: bundle.totals.events,
      projected_tokens: bundle.totals.projected_tokens,
      cost_usd: bundle.totals.cost_usd_recorded || null,
      input_hash: inputHash,
      output_path: outputPath,
      output_sha256: existing.outputHash,
      coverage: { backfill_events: bundle.coverage.backfill_events, occurred_at_missing: bundle.coverage.occurred_at_missing },
      model: modelLabel,
      prompt_version: promptVersion,
      dropped_sessions: null,
      usage: null,
    };
  }

  let markdown: string;
  let usage: UsageTotals | null = null;
  let droppedSessions: number | null = null;
  if (useModel) {
    const provider = options.provider ?? createOpenAiCompatibleProvider(config.model!);
    try {
      const summarized = await summarizeDay(config, bundle, provider);
      markdown = renderModelReport(bundle, summarized.report, { model: modelLabel!, promptVersion: PROMPT_VERSION });
      usage = summarized.usage;
      droppedSessions = summarized.report.dropped_sessions;
    } catch (error) {
      store.insertRun({
        runId, day, model: modelLabel, promptVersion,
        inputHash, status: 'failed', outputPath: null, outputHash: null,
        cost: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }, createdAt: nowIso,
      });
      throw error;
    }
  } else {
    markdown = renderDeterministic(bundle);
  }

  const revision = (existing?.revision ?? 0) + 1;
  const outputHash = sha256(markdown);
  writeNote(outputPath, markdown);

  const result: DreamResult = {
    day,
    status: today ? 'preview' : 'written',
    revision,
    sessions: bundle.totals.sessions,
    events: bundle.totals.events,
    projected_tokens: bundle.totals.projected_tokens,
    cost_usd: bundle.totals.cost_usd_recorded || null,
    input_hash: inputHash,
    output_path: outputPath,
    output_sha256: outputHash,
    coverage: { backfill_events: bundle.coverage.backfill_events, occurred_at_missing: bundle.coverage.occurred_at_missing },
    model: modelLabel,
    prompt_version: promptVersion,
    dropped_sessions: droppedSessions,
    usage,
  };

  const cost = usage ? { ...usage } : null;
  if (today) {
    store.insertRun({
      runId, day, model: modelLabel, promptVersion,
      inputHash, status: 'preview', outputPath, outputHash, cost, createdAt: nowIso,
    });
    return result;
  }

  store.saveDay({
    day,
    status: 'final',
    revision,
    inputHash,
    outputPath,
    outputHash,
    now: nowIso,
  });
  store.insertRun({
    runId, day, model: modelLabel, promptVersion,
    inputHash, status: 'written', outputPath, outputHash, cost, createdAt: nowIso,
  });
  return result;
}
