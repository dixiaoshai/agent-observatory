import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const knowrelayCli = path.resolve('src/interfaces/cli.ts');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const body = (result: unknown) => JSON.parse(((result as { content: Array<{ text: string }> }).content)[0]!.text);

test('archive CLI and stdio MCP expose scoped durable evidence and honor deletion with synthetic pages', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-archive-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'synthetic.jsonl');
  const batchFile = path.join(dir, 'batch.json');
  const deletionFile = path.join(dir, 'deletion.json');
  const config = path.join(dir, 'config.json');
  const text = 'SYNTHETIC_PRIVATE_RESULT';
  const session = 'archive-demo-session';
  const archiveId = 'synthetic-archive';
  const event = { schema_version: 1, event_id: hash(JSON.stringify(['codex', 'local', session, 1])), archive_seq: 1,
    runtime: 'codex', instance_id: 'local', session_id: session, session_key: JSON.stringify(['codex', 'local', session]), project_id: 'demo',
    kind: 'message.user', occurred_at: '2026-01-01T00:00:00Z', observed_at: '2026-01-01T00:00:00Z', native_type: 'event_msg.user_message',
    source: { path: source, line: 1, record_hash: hash(text) },
    data: { turn_id: null, root_turn_id: null, model: null, title: text }, body: { text }, raw: { type: 'event_msg', payload: { type: 'user_message', message: text } } };
  const page = (after: number, next: number, events: unknown[]) => ({ schema_version: 1, archive_id: archiveId, view: 'content', after_cursor: after, next_cursor: next, has_more: false, events });
  const deletion = { ...event, event_id: hash(JSON.stringify(['codex', 'local', session, 'deleted'])), archive_seq: 2,
    kind: 'session.deleted', native_type: 'archive.session_deleted', source: null, data: {}, body: null, raw: null };
  await mkdir(path.join(dir, 'docs'));
  await writeFile(source, text);
  await writeFile(batchFile, JSON.stringify(page(0, 1, [event])));
  await writeFile(deletionFile, JSON.stringify(page(1, 2, [deletion])));
  await writeFile(config, JSON.stringify({ schema_version: 1, database: './knowledge.sqlite', allowed_project_ids: ['demo'], sources: [{ id: 'docs', root: './docs', project_id: 'demo' }] }));
  const kr = async (...args: string[]) => JSON.parse((await run(process.execPath, ['--import', 'tsx', knowrelayCli, ...args, '--config', config])).stdout);
  const consumed = await kr('archive-import', '--input', batchFile);
  assert.equal(consumed.archive_id, archiveId);
  assert.ok(consumed.imported > 0);
  assert.equal((await kr('archive-import', '--input', batchFile)).replayed, true);
  await rm(source);
  const evidence = (await kr('archive-search', '--query', 'SYNTHETIC_PRIVATE_RESULT', '--project', 'demo')).evidence[0];
  assert.equal(evidence.event.kind, 'message.user');
  assert.equal((await kr('archive-read', '--archive', evidence.archive_id, '--event', evidence.event.event_id)).event.source.path, source);
  assert.deepEqual((await kr('search', '--query', 'SYNTHETIC_PRIVATE_RESULT')).results, []);
  await assert.rejects(kr('archive-search', '--query', 'SYNTHETIC_PRIVATE_RESULT', '--project', 'other'));
  await assert.rejects(kr('archive-read', '--archive', evidence.archive_id, '--event', evidence.event.event_id, '--project', 'other'));

  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', knowrelayCli, 'serve', '--config', config], cwd: process.cwd(), stderr: 'pipe' });
  const client = new Client({ name: 'archive-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const search = await client.callTool({ name: 'search_archive', arguments: { query: 'SYNTHETIC_PRIVATE_RESULT', project_id: 'demo' } });
  assert.equal(search.isError, undefined);
  assert.equal(body(search).evidence[0].event.event_id, evidence.event.event_id);
  const read = await client.callTool({ name: 'read_archive_event', arguments: { archive_id: evidence.archive_id, event_id: evidence.event.event_id, project_id: 'demo' } });
  assert.equal(body(read).event.event_id, evidence.event.event_id);
  const denied = await client.callTool({ name: 'search_archive', arguments: { query: 'SYNTHETIC_PRIVATE_RESULT', project_id: 'other' } });
  assert.equal(denied.isError, true);
  const deniedRead = await client.callTool({ name: 'read_archive_event', arguments: { archive_id: evidence.archive_id, event_id: evidence.event.event_id, project_id: 'other' } });
  assert.equal(deniedRead.isError, true);
  const knowledge = await client.callTool({ name: 'search_context', arguments: { query: 'SYNTHETIC_PRIVATE_RESULT', project_id: 'demo' } });
  assert.deepEqual(body(knowledge).results, []);

  assert.equal(consumed.cursor, 1);
  await kr('archive-import', '--input', deletionFile);
  assert.deepEqual((await kr('archive-search', '--query', 'SYNTHETIC_PRIVATE_RESULT')).evidence, []);
  const deletedSearch = await client.callTool({ name: 'search_archive', arguments: { query: 'SYNTHETIC_PRIVATE_RESULT' } });
  assert.deepEqual(body(deletedSearch).evidence, []);
  const deletedRead = await client.callTool({ name: 'read_archive_event', arguments: { archive_id: evidence.archive_id, event_id: evidence.event.event_id } });
  assert.equal(deletedRead.isError, true);
  await client.close();
});
