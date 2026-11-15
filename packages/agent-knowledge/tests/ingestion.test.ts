import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { scanSource } from '../src/ingestion/index.js';

test('scans UTF-8 files and applies nested ignore, security and size filters', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-scan-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source');
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, '.private'));
  await mkdir(path.join(root, 'credentials'));
  await mkdir(path.join(root, 'service-token'));
  await mkdir(path.join(root, 'nested', 'secrets'));
  await writeFile(path.join(root, '.gitignore'), '*.log\nignored.md\n*.txt\n!keep.txt\n');
  await writeFile(path.join(root, 'nested', '.gitignore'), 'private.md\n!local.txt\n');
  await writeFile(path.join(root, 'guide.md'), '中文知识\n第二行\n');
  await writeFile(path.join(root, 'keep.txt'), 'keep');
  await writeFile(path.join(root, 'ignored.md'), 'excluded');
  await writeFile(path.join(root, 'nested', 'private.md'), 'excluded');
  await writeFile(path.join(root, 'nested', 'local.txt'), 'included by nested negation');
  await writeFile(path.join(root, '.env.production'), 'TOKEN=secret');
  await writeFile(path.join(root, 'credentials.json'), '{"password":"secret"}');
  await writeFile(path.join(root, 'secret.key'), 'private key');
  await writeFile(path.join(root, 'node_modules', 'package.js'), 'dependency');
  await writeFile(path.join(root, '.private', 'notes.md'), 'hidden');
  await writeFile(path.join(root, 'credentials', 'notes.md'), 'private credentials');
  await writeFile(path.join(root, 'service-token', 'notes.md'), 'private token');
  await writeFile(path.join(root, 'nested', 'secrets', 'notes.md'), 'private secrets');
  await writeFile(path.join(root, 'too-big.md'), 'x'.repeat(100));
  await writeFile(path.join(root, 'invalid.md'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, 'binary.md'), Buffer.from([0x61, 0, 0x62]));
  await writeFile(path.join(temp, 'outside.md'), 'outside');
  await symlink(path.join(temp, 'outside.md'), path.join(root, 'link.md'));
  await symlink(temp, path.join(root, 'link-dir'));

  const result = await scanSource({ id: 'test', root, project_id: 'project', max_file_bytes: 50 });
  assert.deepEqual(result.files.map((f) => f.path).sort(), ['guide.md', 'keep.txt', 'nested/local.txt']);
  const guide = result.files.find((f) => f.path === 'guide.md')!;
  assert.equal(guide.content, '中文知识\n第二行\n');
  assert.equal(guide.content_hash, createHash('sha256').update(await readFile(path.join(root, 'guide.md'))).digest('hex'));
  assert.equal(guide.git_commit, null);
  const reasons = new Map(result.skipped.map((skip) => [skip.path, skip.reason]));
  assert.equal(reasons.get('ignored.md'), 'ignored');
  assert.equal(reasons.get('nested/private.md'), 'ignored');
  assert.equal(reasons.get('credentials.json'), 'sensitive file');
  assert.equal(reasons.get('credentials'), 'excluded directory');
  assert.equal(reasons.get('service-token'), 'excluded directory');
  assert.equal(reasons.get('nested/secrets'), 'excluded directory');
  assert.equal(reasons.get('secret.key'), 'sensitive file');
  assert.equal(reasons.get('link.md'), 'symbolic link');
  assert.equal(reasons.get('link-dir'), 'symbolic link');
  assert.equal(reasons.get('too-big.md'), 'size limit');
  assert.equal(reasons.get('invalid.md'), 'invalid UTF-8');
  assert.equal(reasons.get('binary.md'), 'binary file');
});

test('rejects missing or symlink roots and invalid settings instead of silently deleting indexed files', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-scan-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await symlink(temp, path.join(temp, 'linked-root'));
  const base = { id: 'test', project_id: 'project' };
  await assert.rejects(scanSource({ ...base, root: path.join(temp, 'missing') }));
  await assert.rejects(scanSource({ ...base, root: path.join(temp, 'linked-root') }), /real directory/);
  await assert.rejects(scanSource({ ...base, root: `${path.join(temp, 'linked-root')}/` }), /real directory/);
  await assert.rejects(scanSource({ ...base, root: temp, max_file_bytes: 0 }), /positive integer/);
  await assert.rejects(scanSource({ ...base, root: temp, include_extensions: ['../md'] }), /Invalid file extension/);
});

test('aborts if ignore rules cannot safely be read', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-scan-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, 'private.md'), 'must not be unexpectedly indexed');
  await writeFile(path.join(temp, 'rules'), 'private.md');
  await symlink(path.join(temp, 'rules'), path.join(temp, '.gitignore'));
  await assert.rejects(scanSource({ id: 'test', root: temp, project_id: 'project' }), /\.gitignore must be a regular file/);
});

test('aborts when a verified child directory is replaced by an out-of-root symlink', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-race-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source');
  const child = path.join(root, 'child');
  const outside = path.join(temp, 'outside');
  await mkdir(child, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(child, 'public.md'), 'public source');
  await writeFile(path.join(outside, 'private.md'), 'must never be imported');
  const canonicalChild = await fsPromises.realpath(child);
  const original = fsPromises.readdir;
  let replaced = false;
  const replacement = mock.method(fsPromises, 'readdir', async (...args: any[]) => {
    if (args[0] === canonicalChild && !replaced) {
      replaced = true;
      await rename(child, path.join(root, 'original-child'));
      await symlink(outside, child);
    }
    return Reflect.apply(original, fsPromises, args);
  });
  try {
    await assert.rejects(scanSource({ id: 'test', root, project_id: 'project' }), /Directory changed while scanning/);
    assert.equal(replaced, true);
  } finally {
    replacement.mock.restore();
  }
});
