import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const cli = path.resolve('src/interfaces/cli.ts');

test('CLI sync and MCP stdio expose only scoped, source-backed read tools', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-mcp-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'docs', 'plan.md'), '# 配置策略\n令牌只保存在安全的 Cookie 中。\n');
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    schema_version: 1, database: './db.sqlite', allowed_project_ids: ['demo'],
    sources: [{ id: 'docs', root: './docs', project_id: 'demo' }],
  }));
  const sync = await run(process.execPath, ['--import', 'tsx', cli, 'sync', '--config', configPath, '--source', 'docs']);
  assert.equal(JSON.parse(sync.stdout).added, 1);

  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, 'serve', '--config', configPath], cwd: process.cwd(), stderr: 'pipe' });
  const client = new Client({ name: 'knowrelay-integration-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['read_archive_event', 'read_record', 'search_archive', 'search_context']);
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);

  const search = await client.callTool({ name: 'search_context', arguments: { query: '安全 Cookie', project_id: 'demo' } });
  assert.equal(search.isError, undefined);
  const searchBody = JSON.parse((search.content as Array<{text: string}>)[0]!.text);
  const found = searchBody.results[0].record;
  assert.equal(found.source_refs[0].path, 'plan.md');
  assert.equal(found.source_refs[0].start_line, 1);
  assert.match(found.source_refs[0].content_hash, /^[0-9a-f]{64}$/);
  assert.ok(found.source_refs[0].source_version_id);
  const read = await client.callTool({ name: 'read_record', arguments: { record_id: found.id } });
  assert.equal(JSON.parse((read.content as Array<{text: string}>)[0]!.text).record.id, found.id);
  const denied = await client.callTool({ name: 'search_context', arguments: { query: 'Cookie', project_id: 'other' } });
  assert.equal(denied.isError, true);
  const deniedRead = await client.callTool({ name: 'read_record', arguments: { record_id: found.id, project_id: 'other' } });
  assert.equal(deniedRead.isError, true);
  const missing = await client.callTool({ name: 'read_record', arguments: { record_id: '/etc/passwd' } });
  assert.equal(missing.isError, true);
  const arbitrary = await client.callTool({ name: 'read_record', arguments: { record_id: found.id, path: '/etc/passwd' } });
  assert.equal(arbitrary.isError, true);
  await writeFile(path.join(dir, 'docs', 'plan.md'), '# 已更新\n资料已变更。\n');
  const stale = await client.callTool({ name: 'read_record', arguments: { record_id: found.id } });
  assert.equal(stale.isError, true);
});
