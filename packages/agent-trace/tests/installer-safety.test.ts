import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { KNOWLEDGE_LABEL, TRACE_LABEL, planInstaller, preflightManagedPaths } from '../scripts/install-content-service.ts';

// CLI subprocesses preload a blocker and cannot invoke launchctl or mutate files.
const home = '/synthetic/home';
const root = '/synthetic/repo/packages/agent-trace';

test('installation and uninstallation fail closed without explicit apply', () => {
  assert.throws(() => planInstaller([], home, root), /--apply/);
  assert.throws(() => planInstaller(['--uninstall'], home, root), /--apply/);
  assert.throws(() => planInstaller(['--apply', '--dry-run'], home, root), /mutually exclusive/);
  assert.throws(() => planInstaller(['--uninstall', '--apply', '--dry-run'], home, root), /mutually exclusive/);
  assert.throws(() => planInstaller(['--unknown', '--apply'], home, root));
});

test('dry-run reports isolated labels and paths without touching config or services', () => {
  const plan = planInstaller(['--dry-run'], home, root);
  assert.equal(plan.action, 'install');
  assert.equal(plan.dryRun, true);
  assert.equal(TRACE_LABEL, 'local.agent-observatory.trace-content');
  assert.equal(KNOWLEDGE_LABEL, 'local.agent-observatory.knowledge-follow');
  assert.equal(plan.traceLabel, TRACE_LABEL);
  assert.equal(plan.knowledgeLabel, KNOWLEDGE_LABEL);
  assert.equal(plan.config, path.join(home, '.local/share/agent-observatory/agent-trace/content.json'));
  assert.equal(plan.tokenFile, path.join(home, '.local/share/agent-observatory/agent-trace/content.token'));
  assert.equal(plan.followConfig, path.join(home, '.local/share/agent-observatory/agent-knowledge/content.follow.json'));
  assert.equal(plan.tracePlist, path.join(home, `Library/LaunchAgents/${TRACE_LABEL}.plist`));
  assert.equal(plan.knowledgePlist, path.join(home, `Library/LaunchAgents/${KNOWLEDGE_LABEL}.plist`));
  assert.equal(plan.knowledgeDir, '/synthetic/repo/packages/agent-knowledge');
  const removal = planInstaller(['--dry-run', '--uninstall', '--no-knowledge'], home, root);
  assert.equal(removal.action, 'uninstall');
  assert.equal(removal.withKnowledge, false);
});

test('real CLI blocks all side effects for no-apply and dry-run', () => {
  const script = path.resolve(import.meta.dirname, '../scripts/install-content-service.ts');
  const blocker = path.resolve(import.meta.dirname, 'block-installer-side-effects.mjs');
  for (const args of [[], ['--uninstall'], ['--dry-run'], ['--dry-run', '--uninstall']]) {
    const result = spawnSync(process.execPath, ['--import', blocker, script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, args.includes('--dry-run') ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stderr, /Test blocked/);
    if (!args.includes('--dry-run')) assert.match(result.stderr, /--apply/);
  }
});

test('managed symlinked state, child log, and plist paths are rejected before launchctl', () => {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'trace-installer-safe-')));
  try {
    const legacy = path.join(temp, 'legacy');
    const fakeHome = path.join(temp, 'home');
    mkdirSync(legacy); mkdirSync(fakeHome);
    const sentinel = path.join(legacy, 'sentinel');
    writeFileSync(sentinel, 'unchanged');
    const stateRoot = path.join(fakeHome, '.local/share/agent-observatory');
    mkdirSync(path.dirname(stateRoot), { recursive: true });
    symlinkSync(legacy, stateRoot);
    for (const args of [['--apply'], ['--apply', '--uninstall']]) {
      const plan = planInstaller(args, fakeHome, root);
      assert.throws(() => preflightManagedPaths(plan), /symlink/);
      if (process.platform === 'darwin') {
        const result = spawnSync(process.execPath, ['--import', path.resolve(import.meta.dirname, 'block-installer-side-effects.mjs'), path.resolve(import.meta.dirname, '../scripts/install-content-service.ts'), ...args], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /symlink/);
        assert.doesNotMatch(result.stderr, /Test blocked/);
      }
    }
    rmSync(stateRoot);
    const plan = planInstaller(['--apply', '--no-knowledge'], fakeHome, root);
    mkdirSync(plan.traceState, { recursive: true });
    symlinkSync(sentinel, path.join(plan.traceState, 'content.log'));
    assert.throws(() => preflightManagedPaths(plan), /symlink/);
    rmSync(path.join(plan.traceState, 'content.log'));
    mkdirSync(plan.agents, { recursive: true });
    symlinkSync(sentinel, plan.tracePlist);
    assert.throws(() => preflightManagedPaths(plan), /symlink/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('apply only authorizes isolated service labels even with explicit config paths', () => {
  for (const args of [['--apply'], ['--apply', '--uninstall'], ['--apply', '--config', '/user/chosen/config.json']]) {
    const plan = planInstaller(args, home, root);
    assert.equal(plan.dryRun, false);
    assert.equal(plan.traceLabel, 'local.agent-observatory.trace-content');
    assert.equal(plan.knowledgeLabel, 'local.agent-observatory.knowledge-follow');
  }
});
