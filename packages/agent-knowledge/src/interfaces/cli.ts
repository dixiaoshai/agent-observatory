#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openApplication } from '../bootstrap.js';
import { AgentKnowledgeError } from '../core/index.js';
import { createMcpServer } from './mcp.js';
import { runFollow } from '../follow/worker.js';

const help = `Agent Knowledge local knowledge service

Usage: agent-knowledge <command> [options]

Commands:
  sync          --source ID [--request-key KEY]
  search        --query QUERY [--project ID] [--limit 1-20]
  read          --id RECORD_ID [--project ID]
  archive-import --input BATCH_JSON
  archive-search --query QUERY [--project ID] [--limit 1-20]
  archive-read  --archive ARCHIVE_ID --event EVENT_ID [--project ID]
  delete-source --source ID
  rebuild-index
  follow        --config FOLLOW_CONFIG
  serve         Start the read-only MCP server on stdio
  help

Every command accepts --config PATH (default: agent-knowledge.example.json, fallback: knowrelay.example.json).
Configuration paths are relative to the configuration file.
`;

const commandOptions: Record<string, ParseArgsConfig['options']> = {
  sync: { source: { type: 'string' }, 'request-key': { type: 'string' } },
  search: { query: { type: 'string' }, project: { type: 'string' }, limit: { type: 'string' } },
  read: { id: { type: 'string' }, project: { type: 'string' } },
  'archive-import': { input: { type: 'string' } },
  'archive-search': { query: { type: 'string' }, project: { type: 'string' }, limit: { type: 'string' } },
  'archive-read': { archive: { type: 'string' }, event: { type: 'string' }, project: { type: 'string' } },
  'delete-source': { source: { type: 'string' } },
  'rebuild-index': {},
  follow: { config: { type: 'string' } },
  serve: {},
  help: {},
};

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AgentKnowledgeError('INVALID_INPUT', `--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') { process.stdout.write(help); return; }
  const options = commandOptions[command];
  if (!options) throw new AgentKnowledgeError('INVALID_INPUT', `Unknown command: ${command}`);
  const parsed = parseArgs({ args, options: { ...options, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  const values: Record<string, string | boolean | undefined> = parsed.values;
  if (values.help || command === 'help') { process.stdout.write(help); return; }
  const configPath = (values.config as string | undefined) ?? (existsSync('agent-knowledge.example.json') ? 'agent-knowledge.example.json' : 'knowrelay.example.json');
  // Validate command arguments before opening the database.
  const source = command === 'sync' || command === 'delete-source' ? required(values.source, 'source') : undefined;
  const query = command === 'search' || command === 'archive-search' ? required(values.query, 'query') : undefined;
  const id = command === 'read' ? required(values.id, 'id') : undefined;
  const input = command === 'archive-import' ? required(values.input, 'input') : undefined;
  const archiveId = command === 'archive-read' ? required(values.archive, 'archive') : undefined;
  const eventId = command === 'archive-read' ? required(values.event, 'event') : undefined;
  const rawLimit = values.limit as string | undefined;
  if (rawLimit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/.test(rawLimit)) throw new AgentKnowledgeError('INVALID_INPUT', '--limit must be an integer between 1 and 20');
  if (command === 'follow') {
    // The follow config points at this knowledge config; do not open the
    // knowledge/MCP application here, so a running MCP client cannot block it.
    process.exitCode = await runFollow(required(values.config, 'config'));
    return;
  }
  const { app, archive, close } = await openApplication(configPath);
  if (command === 'serve') {
    const server = createMcpServer(app, archive);
    const transport = new StdioServerTransport();
    process.stdin.once('end', () => { void server.close().finally(close); });
    try { await server.connect(transport); } catch (error) { close(); throw error; }
    return;
  }
  try {
    let result: unknown;
    switch (command) {
      case 'sync': result = await app.sync(source!, (values['request-key'] as string | undefined) ?? randomUUID()); break;
      case 'search': result = { results: await app.search(query!, values.project as string | undefined, rawLimit === undefined ? undefined : Number(rawLimit)) }; break;
      case 'read': result = { record: await app.read(id!, values.project as string | undefined) }; break;
      case 'archive-import': result = archive.importBatch(JSON.parse(await readFile(input!, 'utf8'))); break;
      case 'archive-search': result = { evidence: archive.search(query!, values.project as string | undefined, rawLimit === undefined ? undefined : Number(rawLimit)) }; break;
      case 'archive-read': result = archive.read(archiveId!, eventId!, values.project as string | undefined); break;
      case 'delete-source': await app.deleteSource(source!); result = { deleted_source: source }; break;
      case 'rebuild-index': result = { indexed: await app.rebuildIndex() }; break;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { close(); }
}

main().catch((error: unknown) => {
  const code = error instanceof AgentKnowledgeError ? error.code : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
});
