import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { contentHash, openApplication, type SourceScanner } from '../src/index.js';

test('public bootstrap accepts a synthetic scanner and retains source and project checks', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-public-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const config = { schema_version: 1, database: './db.sqlite', allowed_project_ids: ['demo'],
    sources: [{ id: 'memory', root: './virtual-root', project_id: 'demo' }] };
  await writeFile(configPath, JSON.stringify(config));
  let content = 'Synthetic source contains blueheron.\n';
  let calls = 0;
  const scanner: SourceScanner = { async scan(source) {
    calls++;
    assert.equal(source.root, path.join(dir, 'virtual-root'));
    return { files: [{ path: 'note.txt', content, content_hash: contentHash(content), git_commit: null }], skipped: [] };
  } };
  const { app, close } = await openApplication(configPath, { scanner });
  t.after(close);
  await assert.rejects(app.sync('unknown', 'bad'), /Source not found/);
  assert.equal(calls, 0);
  assert.equal((await app.sync('memory', 'first')).added, 1);
  const hit = (await app.search('blueheron', 'demo'))[0]!.record;
  assert.equal((await app.read(hit.id)).source_refs[0].path, 'note.txt');
  await assert.rejects(app.read(hit.id, 'other'), /outside/);
  content = 'Synthetic source changed.\n';
  await assert.rejects(app.read(hit.id), /unavailable/);
  assert.equal((await app.sync('memory', 'second')).updated, 1);
  await writeFile(configPath, JSON.stringify({ ...config, sources: [{ ...config.sources[0], root: './other' }] }));
  const rebound = await openApplication(configPath, { scanner });
  try { await assert.rejects(rebound.app.sync('memory', 'third'), /binding changed/); }
  finally { rebound.close(); }
});
