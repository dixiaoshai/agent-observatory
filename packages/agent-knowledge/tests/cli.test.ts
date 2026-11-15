import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/bootstrap.js';

const run = promisify(execFile);
const cli = path.resolve('src/interfaces/cli.ts');

test('CLI help works and invalid arguments fail without a database', async () => {
  const help = await run(process.execPath, ['--import', 'tsx', cli, 'help']);
  assert.match(help.stdout, /search/);
  await assert.rejects(run(process.execPath, ['--import', 'tsx', cli, 'search', '--limit', '30', '--query', 'hello']), (error: any) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'INVALID_INPUT');
    return true;
  });
  await assert.rejects(run(process.execPath, ['--import', 'tsx', cli, 'sync', '--unknown', 'x']));
});

test('config resolves relative paths and rejects unexpected fields and duplicate IDs', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-config-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'config.json');
  const source = { id: 'one', root: './docs', project_id: 'demo' };
  const data = { schema_version: 1, database: './db/knowledge.sqlite', allowed_project_ids: ['demo'], sources: [source] };
  await writeFile(filename, JSON.stringify(data));
  const config = await loadConfig(filename);
  assert.equal(config.database, path.join(dir, 'db/knowledge.sqlite'));
  assert.equal(config.sources[0]?.root, path.join(dir, 'docs'));
  await writeFile(filename, JSON.stringify({ ...data, sources: [source, source] }));
  await assert.rejects(loadConfig(filename));
  await writeFile(filename, JSON.stringify({ ...data, owner_id: 'impersonated' }));
  await assert.rejects(loadConfig(filename));
  assert.ok((await readFile(filename, 'utf8')).includes('impersonated'));
});

test('default config prefers the canonical name, falls back to legacy, and respects explicit config', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-knowledge-defaults-')));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'documents'));
  await writeFile(path.join(dir, 'documents', 'example.md'), 'Synthetic default configuration evidence.\n');
  const config = (name: string) => ({ schema_version: 1, database: `./${name}.sqlite`, allowed_project_ids: ['demo'], sources: [{ id: name, root: './documents', project_id: 'demo' }] });
  const legacyPath = path.join(dir, 'knowrelay.example.json');
  await writeFile(legacyPath, JSON.stringify(config('legacy')));
  // Absolute loader path keeps tsx resolvable while exercising another cwd.
  const loader = import.meta.resolve('tsx');
  const invoke = async (args: string[]) => JSON.parse((await run(process.execPath, ['--import', loader, cli, ...args], { cwd: dir })).stdout);
  assert.equal((await invoke(['sync', '--source', 'legacy'])).source_id, 'legacy');
  await writeFile(path.join(dir, 'agent-knowledge.example.json'), JSON.stringify(config('canonical')));
  assert.equal((await invoke(['sync', '--source', 'canonical'])).source_id, 'canonical');
  assert.equal((await invoke(['sync', '--source', 'legacy', '--config', legacyPath])).source_id, 'legacy');
});
