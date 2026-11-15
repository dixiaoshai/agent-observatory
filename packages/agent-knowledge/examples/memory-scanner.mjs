// Run after npm run build: node examples/memory-scanner.mjs
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentHash, openApplication } from '../dist/index.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-memory-'));
try {
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    schema_version: 1, database: './knowledge.sqlite', allowed_project_ids: ['demo'],
    sources: [{ id: 'memory', root: './virtual-root', project_id: 'demo' }],
  }));
  const content = 'Synthetic handbook: the launch codeword is blueheron.\n';
  // This scanner reads no files; its paths are source-relative logical names.
  const scanner = { async scan(source) {
    if (source.id !== 'memory') throw new Error('Unexpected source');
    return { files: [{ path: 'handbook.txt', content, content_hash: contentHash(content), git_commit: null }], skipped: [] };
  } };
  const { app, close } = await openApplication(configPath, { scanner });
  try {
    await app.sync('memory', 'initial');
    const hits = await app.search('blueheron', 'demo');
    console.log(JSON.stringify(hits.map(({ record }) => ({ content: record.content, source: record.source_refs[0] })), null, 2));
  } finally { close(); }
} finally { await rm(dir, { recursive: true, force: true }); }
