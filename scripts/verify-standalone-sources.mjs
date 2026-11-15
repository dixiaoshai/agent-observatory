#!/usr/bin/env node
/** Full module checks in sibling-free source copies, never silently skip tests. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeTestsComplete, assertPythonTestsComplete } from './test-summary.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agent-observatory-source-checks-')));
const excluded = new Set(['node_modules', 'dist', 'build', '.git', '.cache', '__pycache__', '.agent-journal', '.agent-trace', '.agent-stats', '.knowrelay']);
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
for (const key of ['NODE_PATH', 'PYTHONPATH', 'PYTHONHOME']) delete env[key];
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed`);
  return (result.stdout ?? '') + '\n' + (result.stderr ?? '');
}
try {
  for (const name of ['agent-trace', 'agent-journal', 'agent-knowledge', 'agent-stats']) {
    const parent = path.join(temporary, name);
    mkdirSync(parent);
    const checkout = path.join(parent, 'checkout');
    cpSync(path.join(root, 'packages', name), checkout, { recursive: true, dereference: true, filter: source => !excluded.has(path.basename(source)) && !source.endsWith('.egg-info') });
    for (const sibling of ['agent-trace', 'agent-journal', 'agent-knowledge', 'agent-stats']) {
      assert(!existsSync(path.join(parent, sibling)), `Unexpected sibling ${sibling}`);
    }
    if (name === 'agent-stats') {
      const output = run('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], checkout);
      assertPythonTestsComplete(output, name);
    } else {
      // Standalone lockfiles can legitimately pin transitive versions not in
      // the workspace cache. Prefer cached tarballs, but permit normal fetches.
      run('npm', ['ci', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(root, '.cache/npm')], checkout);
      const output = run('npm', ['run', 'check'], checkout);
      assertNodeTestsComplete(output, name);
    }
    console.log(`${name}: full standalone source check passed`);
  }
} finally {
  const resolved = realpathSync(temporary);
  assert.equal(resolved, temporary);
  assert.equal(path.dirname(resolved), realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('agent-observatory-source-checks-'));
  rmSync(resolved, { recursive: true, force: true });
}
