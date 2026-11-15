#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, configSummary, tokenFromEnv, type JournalConfig } from './config.ts';
import { localDateOf, previousLocalDay } from './day.ts';
import { dreamDay } from './dream.ts';
import { asJournalError, JournalError } from './errors.ts';
import { JournalStore } from './store.ts';
import { createOpenAiCompatibleProvider } from './provider.ts';
import { syncArchive } from './sync.ts';
import { importActivitySnapshot } from './source.ts';

const help = `Agent Journal: daily review of work done with coding agents

Usage: agent-journal <command> [options]

Commands:
  config-check   --config PATH                 Validate configuration (no database or network)
  verify-model   --config PATH                 Send one tiny request to the configured model (no journal DB)
  sync           --config PATH                 Pull the next Trace content pages and commit the cursor
  import         --config PATH --file PATH     Import an offline activity JSON snapshot
  dream          --config PATH (--date D | --today) [--no-sync] [--force] [--include-backfill] [--no-model]
  run            --config PATH [--date D]      sync + write the previous day's note (launchd entry)
  status         --config PATH                 Show sync state and local counts
  help

Every command accepts --config PATH (default: agent-journal.example.json).
The Trace token is read only from the environment variable named by config.token_env.
`;

const options = {
  config: { type: 'string' as const },
  file: { type: 'string' as const },
  date: { type: 'string' as const },
  today: { type: 'boolean' as const },
  'no-sync': { type: 'boolean' as const },
  force: { type: 'boolean' as const },
  'include-backfill': { type: 'boolean' as const },
  'no-model': { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' },
};

const commandOptions: Record<string, Record<string, { type: 'string' | 'boolean'; short?: string }>> = {
  'config-check': { config: options.config },
  sync: { config: options.config },
  import: { config: options.config, file: options.file },
  dream: { config: options.config, date: options.date, today: options.today, 'no-sync': options['no-sync'], force: options.force, 'include-backfill': options['include-backfill'], 'no-model': options['no-model'] },
  run: { config: options.config, date: options.date, force: options.force, 'include-backfill': options['include-backfill'], 'no-model': options['no-model'] },
  status: { config: options.config },
  'verify-model': { config: options.config },
  help: {},
};

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function resolveConfigPath(flag: string | undefined): string {
  const candidate = flag ?? process.env.AGENT_JOURNAL_CONFIG ?? 'agent-journal.example.json';
  if (!existsSync(candidate)) throw new JournalError('INVALID_CONFIG', 'config', `Configuration file not found: ${candidate}`);
  return candidate;
}

async function openStore(config: JournalConfig): Promise<JournalStore> {
  return new JournalStore(config.database);
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (command === '--help' || command === '-h') { process.stdout.write(help); return; }
  const allowed = commandOptions[command];
  if (!allowed) throw new JournalError('INVALID_INPUT', 'config', `Unknown command: ${command}`);
  const parsed = parseArgs({ args: rest, options: { ...allowed, help: options.help }, strict: true, allowPositionals: false });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help || command === 'help') { process.stdout.write(help); return; }
  const configPath = resolveConfigPath(values.config as string | undefined);

  if (command === 'config-check') {
    const config = loadConfig(configPath);
    const summary = configSummary(config);
    summary.token_present = Boolean(process.env[config.tokenEnv]);
    summary.model_key_present = config.model ? Boolean(process.env[config.model.apiKeyEnv]) : null;
    output(summary);
    return;
  }

  const config = loadConfig(configPath);

  if (command === 'verify-model') {
    if (!config.model) throw new JournalError('MODEL_NOT_CONFIGURED', 'config', 'config.model is required for verify-model');
    if (!process.env[config.model.apiKeyEnv]?.trim()) {
      throw new JournalError('MODEL_KEY_MISSING', 'config', `Environment variable ${config.model.apiKeyEnv} is missing or empty`);
    }
    const provider = createOpenAiCompatibleProvider(config.model);
    const result = await provider.complete([
      { role: 'system', content: 'Reply with JSON only. Do not add commentary.' },
      { role: 'user', content: 'Return exactly this JSON and nothing else: {"ok":true}' },
    ], { maxOutputTokens: 512 });
    output({ model: result.model, content: result.content, usage: result.usage });
    return;
  }
  const store = await openStore(config);
  try {
    switch (command) {
      case 'import': {
        if (typeof values.file !== 'string' || !values.file) throw new JournalError('INVALID_INPUT', 'config', '--file is required');
        let input: unknown;
        try { input = JSON.parse(readFileSync(values.file, 'utf8')); }
        catch { throw new JournalError('INVALID_INPUT', 'config', 'Cannot read or parse activity JSON file'); }
        output(importActivitySnapshot(config, store, input));
        return;
      }
      case 'sync': {
        const result = await syncArchive(config, store);
        output(result);
        return;
      }
      case 'dream': {
        const today = values.today === true;
        const date = values.date as string | undefined;
        const noSync = values['no-sync'] === true;
        if (today && date) throw new JournalError('INVALID_INPUT', 'config', '--today and --date are mutually exclusive');
        if (!today && !date) throw new JournalError('INVALID_INPUT', 'config', '--date or --today is required');
        if (!today && !noSync) await syncArchive(config, store);
        const day = today ? localDateOf(Date.now(), config.timezone) : date!;
        const result = await dreamDay(config, store, day, {
          today,
          force: values.force === true,
          includeBackfill: values['include-backfill'] === true,
          useModel: values['no-model'] !== true,
        });
        output({ synced: !today && !noSync, ...result });
        return;
      }
      case 'run': {
        const syncResult = await syncArchive(config, store);
        const day = (values.date as string | undefined)
          ?? previousLocalDay(localDateOf(Date.now(), config.timezone));
        const result = await dreamDay(config, store, day, {
          force: values.force === true,
          includeBackfill: values['include-backfill'] === true,
          useModel: values['no-model'] !== true,
          highWatermark: syncResult.high_watermark,
        });
        output({ sync: syncResult, dream: result });
        return;
      }
      case 'status': {
        output({
          ...store.summary(),
          token_present: Boolean(process.env[config.tokenEnv]),
          timezone: config.timezone,
          trace_url: config.traceUrl,
          output_directory: config.outputDirectory,
        });
        return;
      }
      default:
        throw new JournalError('INVALID_INPUT', 'config', `Unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const journalError = asJournalError(error);
  process.stderr.write(`${JSON.stringify({ error: { code: journalError.code, class: journalError.klass, message: journalError.message } })}\n`);
  process.exitCode = 1;
});
