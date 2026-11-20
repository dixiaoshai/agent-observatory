#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Archive, sourceFiles } from './store.ts';
import { describeServiceConfig, loadServiceConfig, projectForCwd } from './config.ts';
import { acquireCollectionLease, ensureCollectionSchema, releaseCollectionLease, sourceKey } from './collector.ts';
import { TraceService, type ServiceEvent } from './service.ts';
import { readSessionTitles, titleLookup, type TitleLookup } from './titles.ts';
import { ArchiveError, cursorOf, identifier, runtimeHint as parseRuntimeHint, viewOf } from './types.ts';
import { defaultDatabase } from './paths.ts';

const help = `Agent Trace — local shared execution evidence
Usage: agent-trace <command> [options]
Node.js >=24.15.0; no runtime dependencies; no automatic history import.

Commands (all accept --db PATH, default .agent-trace/trace.sqlite):
  ingest --source PATH [--source PATH ...] --instance ID --project ID [--runtime auto|codex|pi|dsh] [--capture metadata|content]
  reingest --config PATH [--db PATH]
  export [--after CURSOR] [--limit 1..10000] [--view metadata|content] [--output FILE]
  read --event ID [--view metadata|content]
  delete-session --runtime codex --instance ID --session ID
  status
  gc --config PATH [--db PATH] [--dry-run]
  config-check --config PATH [--db PATH]
  serve --config PATH [--db PATH]
  help

reingest re-reads every source file the configured collector already imported
and appends events for source records that are new to the archive (for example
later session.title revisions). It cannot upgrade an event payload that was
produced by an older projection: unchanged source rows are deduplicated by their
source hash, so an adapter semantic change requires rebuilding the archive from
its configured sources into a new database and recreating the consumer databases.
An archive written by another projection refuses writes with PROJECTION_MISMATCH;
status reports normalizer_version. Files the harness has since pruned count as
missing instead of failing, and the collection lease is required, so the
collector must be stopped first. gc removes blob files in the configured content
archive that no committed event cites (for example files left by an interrupted
import); --dry-run only reports. Content capture saves selected original
prompts, tools and visible reasoning. Capture mode is fixed per database;
metadata is the default. Export files may contain private information and are
independent copies with their own lifecycle. An existing
.agent-archive/archive.sqlite remains the fallback when the new default database
does not exist. An explicit --db always takes precedence. config-check validates
a service configuration without creating a database, starting collection or
opening a listener. serve runs collection and/or the read-only loopback API in
the foreground until SIGINT/SIGTERM; startup, scan and stop events are emitted
as NDJSON. See docs/SERVICE-CONFIG.md and docs/LOCAL-API.md.
`;
const commandOptions: Record<string, ParseArgsConfig['options']> = {
  ingest: { source: { type: 'string', multiple: true }, instance: { type: 'string' }, project: { type: 'string' }, runtime: { type: 'string' }, capture: { type: 'string' } },
  export: { after: { type: 'string' }, limit: { type: 'string' }, view: { type: 'string' }, output: { type: 'string' } },
  read: { event: { type: 'string' }, view: { type: 'string' } },
  'delete-session': { runtime: { type: 'string' }, instance: { type: 'string' }, session: { type: 'string' } },
  status: {}, gc: { config: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  'config-check': { config: { type: 'string' } }, serve: { config: { type: 'string' } },
  reingest: { config: { type: 'string' } }, help: {},
};
async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') { process.stdout.write(help); return; }
  if (!Object.hasOwn(commandOptions, command)) throw new ArchiveError('INVALID_INPUT', `Unknown command: ${command}`);
  const parsed = parseArgs({ args, options: { ...commandOptions[command], db: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  const v: Record<string, string | string[] | boolean | undefined> = parsed.values;
  if (command === 'help' || v.help) { process.stdout.write(help); return; }
  const sources = command === 'ingest' ? v.source as string[] | undefined : undefined;
  const instance = command === 'ingest' || command === 'delete-session' ? identifier(v.instance, '--instance') : '';
  const project = command === 'ingest' ? identifier(v.project, '--project') : '';
  const session = command === 'delete-session' ? identifier(v.session, '--session') : '';
  const runtime = command === 'delete-session' ? identifier(v.runtime, '--runtime') : '';
  const runtimeHint = command === 'ingest'
    ? (v.runtime === undefined ? 'auto' : parseRuntimeHint(identifier(v.runtime, '--runtime')))
    : 'auto';
  if (runtimeHint === null) {
    throw new ArchiveError('INVALID_INPUT', '--runtime must be auto, codex, pi or dsh (alias deepseek-harness)');
  }
  if (command === 'ingest' && !sources?.length) throw new ArchiveError('INVALID_INPUT', 'At least one --source is required');
  const eventId = command === 'read' ? identifier(v.event, '--event') : '';
  const after = command === 'export' ? cursorOf(Number(v.after ?? 0)) : 0;
  const limit = Number(v.limit ?? 500);
  if (command === 'export' && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)) throw new ArchiveError('INVALID_INPUT', '--limit must be 1..10000');
  const view = viewOf(v.view ?? 'metadata');
  const capture = v.capture === undefined ? undefined : viewOf(v.capture);
  const configPath = command === 'config-check' || command === 'serve' || command === 'gc' || command === 'reingest'
    ? identifier(v.config, '--config') : '';
  let result: unknown;
  if (command === 'serve') {
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    const service = new TraceService(config, {
      onEvent: (event: ServiceEvent) => process.stdout.write(`${JSON.stringify(event)}\n`),
    });
    await service.start();
    await new Promise<void>(resolve => {
      let stopping = false;
      const shutdown = (reason: string): void => {
        if (stopping) return;
        stopping = true;
        void service.stop(reason).then(() => resolve(), error => {
          process.stderr.write(`${JSON.stringify({ error: { code: error instanceof ArchiveError ? error.code : 'STOP_FAILED', message: error instanceof Error ? error.message : 'Unknown stop error' } })}\n`);
          resolve();
        });
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    });
    return;
  }
  if (command === 'config-check') {
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    result = describeServiceConfig(config);
  } else if (command === 'gc') {
    if (!configPath) throw new ArchiveError('INVALID_INPUT', 'gc requires --config: the blob directory comes from the service configuration');
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    const archive = new Archive(config.database, undefined, config.content);
    try { result = archive.pruneOrphanBlobs({ dry_run: v['dry-run'] === true }); } finally { archive.close(); }
  } else if (command === 'reingest') {
    if (!configPath) throw new ArchiveError('INVALID_INPUT', 'reingest requires --config: the archive, sources and project scopes come from the service configuration');
    const config = loadServiceConfig(configPath, { database: typeof v.db === 'string' ? v.db : undefined });
    const archive = new Archive(config.database, config.capture_mode, config.content);
    archive.assertProjectionCurrent();
    const owner = `reingest-${randomUUID()}`;
    let leased = false;
    try {
      ensureCollectionSchema(archive.db);
      const lease = acquireCollectionLease(archive.db, owner);
      if (!lease.acquired) {
        throw new ArchiveError('COLLECTION_BUSY', 'Collection lease is held by another process; stop the collector before running reingest');
      }
      leased = true;
      const sources = new Map(config.collection.sources.map(source => [sourceKey(source), source]));
      const titles = new Map<string, TitleLookup>();
      const tracked = archive.db.prepare("SELECT source_key,path FROM collection_files WHERE outcome='imported' ORDER BY path")
        .all() as Array<{ source_key: string; path: string }>;
      let imported = 0, skipped = 0, missing = 0;
      const pending: string[] = [];
      const errors: Array<{ path: string; code: string }> = [];
      for (const row of tracked) {
        const source = sources.get(String(row.source_key));
        if (!source) { errors.push({ path: String(row.path), code: 'SOURCE_UNCONFIGURED' }); continue; }
        let lookup = titles.get(String(row.source_key));
        if (!lookup) {
          lookup = titleLookup(readSessionTitles(source.root));
          titles.set(String(row.source_key), lookup);
        }
        try {
          const report = archive.importFile(String(row.path), source.instance_id, cwd => {
            const match = projectForCwd(source, cwd);
            if ('error' in match) throw new ArchiveError(match.error, match.message);
            return match.project_id;
          }, lookup, source.runtime);
          imported += report.imported;
          skipped += report.skipped;
          if (report.pending) pending.push(String(row.path));
        } catch (error) {
          // Harnesses prune their own logs (Codex removes old rollouts) while the
          // archive keeps their captured evidence. An absent tracked source is
          // therefore expected on upgrade and not a failure of this command.
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') { missing++; continue; }
          errors.push({ path: String(row.path), code: error instanceof ArchiveError ? error.code : 'SOURCE_ERROR' });
        }
      }
      result = { archive_id: archive.archiveId, scanned: tracked.length, imported, skipped, missing, pending, errors };
      if (errors.length) process.exitCode = 1;
    } finally {
      if (leased) {
        try { releaseCollectionLease(archive.db, owner); } catch { /* preserve the original failure */ }
      }
      archive.close();
    }
  } else {
    const archive = new Archive(v.db as string | undefined ?? defaultDatabase(), capture);
    try {
      switch (command) {
        case 'ingest': {
          archive.assertProjectionCurrent();
          const files = sourceFiles(sources!);
          let imported = 0, skipped = 0;
          const pending: string[] = [], errors: Array<{ path: string; code: string }> = [];
          for (const filename of files) {
            try {
              const report = archive.importFile(filename, instance, project, undefined, runtimeHint);
              imported += report.imported; skipped += report.skipped;
              if (report.pending) pending.push(filename);
            } catch (error) { errors.push({ path: filename, code: error instanceof ArchiveError ? error.code : 'SOURCE_ERROR' }); }
          }
          result = { archive_id: archive.archiveId, scanned: files.length, imported, skipped, pending, errors };
          if (errors.length) process.exitCode = 1;
          break;
        }
        case 'export': result = archive.exportBatch(after, limit, view); break;
        case 'read': result = { event: archive.readEvent(eventId, view) }; break;
        case 'delete-session':
          archive.assertProjectionCurrent();
          result = archive.deleteSession(runtime, instance, session); break;
        case 'status': result = archive.status(); break;
      }
    } finally { archive.close(); }
  }
  const output = `${JSON.stringify(result)}\n`;
  if (command === 'export' && typeof v.output === 'string') writeFileSync(v.output, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  else process.stdout.write(output);
}
try { await main(); }
catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { code: error instanceof ArchiveError ? error.code : 'ERROR', message: error instanceof Error ? error.message : 'Unknown error' } })}\n`);
  process.exitCode = 1;
}
