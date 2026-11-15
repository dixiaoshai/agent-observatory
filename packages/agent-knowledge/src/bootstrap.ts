import { mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentKnowledge } from './application/index.js';
import type { SourceScanner } from './application/ports.js';
import { scanSource } from './ingestion/index.js';
import { SqliteStore } from './storage/index.js';
import { ArchiveEvidenceStore } from './archive/index.js';

const identifier = z.string().min(1).max(200).refine((s) => s.trim() === s && !/[\x00-\x1f]/.test(s), 'Invalid identifier');
const configSchema = z.strictObject({
  schema_version: z.literal(1),
  database: z.string().min(1),
  allowed_project_ids: z.array(identifier).min(1),
  sources: z.array(z.strictObject({
    id: identifier,
    root: z.string().min(1),
    project_id: identifier,
    include_extensions: z.array(z.string().regex(/^\.[a-zA-Z0-9]+$/)).optional(),
    max_file_bytes: z.number().int().min(1).max(100_000_000).optional(),
  })).min(1),
}).superRefine((config, context) => {
  if (new Set(config.allowed_project_ids).size !== config.allowed_project_ids.length) {
    context.addIssue({ code: 'custom', path: ['allowed_project_ids'], message: 'Duplicate project ID' });
  }
  if (new Set(config.sources.map((source) => source.id)).size !== config.sources.length) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Duplicate source ID' });
  }
  for (const [index, source] of config.sources.entries()) {
    if (!config.allowed_project_ids.includes(source.project_id)) {
      context.addIssue({ code: 'custom', path: ['sources', index, 'project_id'], message: 'Project is not in allowed_project_ids' });
    }
  }
});

export type Config = z.infer<typeof configSchema>;

/** Relative paths are relative to the configuration file, never to an MCP request. */
export async function loadConfig(configPath: string): Promise<Config> {
  const absolutePath = path.resolve(configPath);
  const config = configSchema.parse(JSON.parse(await readFile(absolutePath, 'utf8')));
  const directory = path.dirname(absolutePath);
  return {
    ...config,
    database: path.resolve(directory, config.database),
    sources: config.sources.map((source) => ({ ...source, root: path.resolve(directory, source.root) })),
  };
}

/** Local owner identity; every database and MCP request uses this same value. */
export function localOwnerId(): string {
  return `uid:${userInfo().uid}`;
}

/** Evidence projection file that belongs to a knowledge database. */
export function evidenceDatabasePath(database: string): string {
  return `${database}.archive-evidence.sqlite`;
}

export async function openApplication(configPath: string, options: { scanner?: SourceScanner } = {}): Promise<{ app: AgentKnowledge; archive: ArchiveEvidenceStore; close: () => void; config: Config }> {
  const config = await loadConfig(configPath);
  await mkdir(path.dirname(config.database), { recursive: true, mode: 0o700 });
  const store = new SqliteStore(config.database);
  let archive: ArchiveEvidenceStore;
  // Separate projection DB: synchronous archive imports cannot block a pending
  // async knowledge transaction on another connection in this same process.
  try { archive = new ArchiveEvidenceStore(evidenceDatabasePath(config.database), localOwnerId(), config.allowed_project_ids); }
  catch (error) { store.close(); throw error; }
  const app = new AgentKnowledge(
    { owner_id: localOwnerId(), allowed_project_ids: config.allowed_project_ids, sources: config.sources },
    store.repositories, store.uow, store.index, options.scanner ?? { scan: scanSource },
  );
  return { app, archive, close: () => { archive.close(); store.close(); }, config };
}
