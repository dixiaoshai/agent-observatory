#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
for (const name of ['agent-trace', 'agent-journal', 'agent-knowledge']) {
  execFileSync('npm', ['pack', '--workspace', name, '--pack-destination', artifacts, '--cache', path.join(root, '.cache/npm')], { cwd: root, stdio: 'inherit' });
}
execFileSync('python3', ['-m', 'pip', 'wheel', '--no-cache-dir', '--no-deps', '--no-build-isolation', '--wheel-dir', artifacts,
  path.join(root, 'packages/agent-stats')], { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
console.log(`Independent local distribution files: ${artifacts}`);
