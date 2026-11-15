import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tempDirectory } from './helpers.ts';
import { LABEL, buildJob, parseOptions, preflightManagedPaths } from '../scripts/install-macos-service.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/install-macos-service.ts');
const TOKEN_SENTINEL = 'installer-test-token-value-never-print';
const KEY_SENTINEL = 'installer-test-key-value-never-print';

interface InstallerFixture {
  directory: string;
  configPath: string;
  stateDir: string;
  plistDir: string;
  tokenFile: string;
  keyFile: string;
}

function writeJournalConfig(directory: string): string {
  const configPath = path.join(directory, 'journal.json');
  writeFileSync(configPath, `${JSON.stringify({
    schema_version: 1,
    timezone: 'Asia/Shanghai',
    database: './journal.sqlite',
    trace_url: 'http://127.0.0.1:18767',
    token_env: 'AGENT_TRACE_JOURNAL_TOKEN',
    output_directory: './daily',
    projects: ['fixture'],
    page_size: 500,
    finalize: { grace_hours: 6, max_days_per_run: 7, late_observed_hours: 36 },
    budget: { max_input_tokens_per_day: 120000, max_output_tokens_per_day: 100000 },
    model: {
      provider: 'openai-compatible',
      base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      api_key_env: 'DEEPSEEK_API_KEY',
      timeout_seconds: 300,
      max_output_tokens: 16000,
    },
  }, null, 2)}\n`);
  return configPath;
}

/** Temp config plus sentinel secret files; state/plist paths must not exist yet. */
function fixture(): InstallerFixture {
  const directory = tempDirectory();
  const secrets = path.join(directory, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(secrets, 'content.token');
  const keyFile = path.join(secrets, 'deepseek.key');
  writeFileSync(tokenFile, `${TOKEN_SENTINEL}\n`, { mode: 0o600 });
  writeFileSync(keyFile, `${KEY_SENTINEL}\n`, { mode: 0o600 });
  return {
    directory,
    configPath: writeJournalConfig(directory),
    stateDir: path.join(directory, 'state'),
    plistDir: path.join(directory, 'LaunchAgents'),
    tokenFile,
    keyFile,
  };
}

function baseArgs(f: InstallerFixture): string[] {
  return [
    '--config', f.configPath,
    '--state-dir', f.stateDir,
    '--plist-dir', f.plistDir,
    '--token-file', f.tokenFile,
    '--deepseek-key-file', f.keyFile,
  ];
}

function runInstaller(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_TRACE_JOURNAL_TOKEN;
  delete env.DEEPSEEK_API_KEY;
  return spawnSync(process.execPath, ['--import', path.join(ROOT, 'tests/block-installer-subprocess.mjs'), '--experimental-strip-types', SCRIPT, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

function parsePlan(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

test('dry-run prints the plist and wrapper plan without touching disk', () => {
  const f = fixture();
  const result = runInstaller(['--dry-run', ...baseArgs(f)]);
  assert.equal(result.status, 0, result.stderr);
  const plan = parsePlan(result.stdout);

  assert.equal(plan.dry_run, true);
  assert.equal(plan.label, LABEL);
  assert.equal(plan.plist_path, path.join(f.plistDir, `${LABEL}.plist`));
  assert.equal(plan.wrapper_path, path.join(f.stateDir, 'run.sh'));

  const plist = plan.plist as Record<string, unknown>;
  assert.equal(plist.Label, LABEL);
  assert.deepEqual(plist.ProgramArguments, ['/bin/sh', path.join(f.stateDir, 'run.sh')]);
  assert.equal(plist.WorkingDirectory, ROOT);
  assert.deepEqual(plist.StartCalendarInterval, { Hour: 6, Minute: 30 });
  assert.equal(plist.RunAtLoad, false);
  assert.equal(plist.ProcessType, 'Background');
  assert.equal(plist.StandardOutPath, path.join(f.stateDir, 'run.log'));
  assert.equal(plist.StandardErrorPath, path.join(f.stateDir, 'run.err'));
  assert.deepEqual(plist.EnvironmentVariables, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });

  const wrapper = plan.wrapper as string;
  assert.equal(typeof wrapper, 'string');
  assert.ok(wrapper.includes(`NODE='${process.execPath}'`));
  assert.ok(wrapper.includes(`${path.join(ROOT, 'dist/cli.js')}`));
  assert.ok(wrapper.includes('run --config "$CONFIG"'));
  assert.ok(wrapper.includes('AGENT_TRACE_JOURNAL_TOKEN="$(cat "$TOKEN_FILE")"'));
  assert.ok(wrapper.includes('export AGENT_TRACE_JOURNAL_TOKEN'));
  assert.ok(wrapper.includes('DEEPSEEK_API_KEY="$(cat "$KEY_FILE")"'));
  assert.ok(wrapper.includes('export DEEPSEEK_API_KEY'));
  assert.ok(wrapper.includes('umask 077'));
  assert.equal(wrapper.includes('set -x'), false);
  assert.equal(wrapper.includes('FOLLOW_LOCKED'), true);

  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(TOKEN_SENTINEL), false);
  assert.equal(serialized.includes(KEY_SENTINEL), false);
  assert.equal(serialized.includes('DEEPSEEK_API_KEY="' + KEY_SENTINEL), false);

  assert.ok(Array.isArray(plan.commands) && (plan.commands as string[]).length > 0);
  assert.ok(Array.isArray(plan.notes) && (plan.notes as string[]).length > 0);

  // Dry run must not create anything.
  assert.equal(existsSync(f.stateDir), false);
  assert.equal(existsSync(f.plistDir), false);
  assert.equal(existsSync(path.join(f.plistDir, `${LABEL}.plist`)), false);
});

test('dry-run with --knowledge-source includes the Knowledge sync step', () => {
  const f = fixture();
  const knowledgeDir = path.join(f.directory, 'knowledge');
  const knowledgeCli = path.join(knowledgeDir, 'dist/interfaces/cli.js');
  mkdirSync(path.dirname(knowledgeCli), { recursive: true });
  writeFileSync(knowledgeCli, '// stub build for installer tests\n');
  const knowledgeConfig = path.join(f.directory, 'knowledge-content.json');
  writeFileSync(knowledgeConfig, '{}\n');

  const withKnowledge = runInstaller([
    '--dry-run', ...baseArgs(f),
    '--knowledge-dir', knowledgeDir,
    '--knowledge-config', knowledgeConfig,
    '--knowledge-source', 'docs',
  ]);
  assert.equal(withKnowledge.status, 0, withKnowledge.stderr);
  const plan = parsePlan(withKnowledge.stdout);
  assert.ok(JSON.stringify(plan).includes('sync --source docs'));
  const wrapper = plan.wrapper as string;
  assert.ok(wrapper.includes(knowledgeCli));
  assert.ok(wrapper.includes('KNOWLEDGE_SOURCE=\'docs\''));
  assert.ok(wrapper.includes('sync --source "$KNOWLEDGE_SOURCE" --config "$KNOWLEDGE_CONFIG"'));

  const withoutKnowledge = runInstaller(['--dry-run', ...baseArgs(f)]);
  assert.equal(withoutKnowledge.status, 0, withoutKnowledge.stderr);
  assert.equal(JSON.stringify(parsePlan(withoutKnowledge.stdout)).includes('sync --source'), false);
});

test('--uninstall --dry-run prints the removal plan and changes nothing', () => {
  const f = fixture();
  const result = runInstaller(['--dry-run', '--uninstall', '--state-dir', f.stateDir, '--plist-dir', f.plistDir]);
  assert.equal(result.status, 0, result.stderr);
  const plan = parsePlan(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.uninstall, true);
  assert.equal(plan.label, LABEL);
  assert.equal(plan.plist_path, path.join(f.plistDir, `${LABEL}.plist`));
  const commands = plan.commands as string[];
  assert.ok(commands.some((command) => command.includes('bootout')));
  assert.ok(commands.some((command) => command.includes('rm -f') && command.includes(path.join(f.plistDir, `${LABEL}.plist`))));
  assert.equal(existsSync(f.plistDir), false);
  assert.equal(existsSync(f.stateDir), false);
});

test('missing config is rejected with a clear message', () => {
  const f = fixture();
  const missing = path.join(f.directory, 'missing.json');
  const result = runInstaller(['--dry-run', '--config', missing, '--state-dir', f.stateDir, '--plist-dir', f.plistDir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing configuration/);
  assert.equal(result.stdout, '');
});

test('--retries out of range is rejected', () => {
  const f = fixture();
  const result = runInstaller(['--dry-run', '--retries', '9', ...baseArgs(f)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /retries/);
  assert.equal(result.stdout, '');
});

test('install and uninstall without --apply refuse before any mutation', () => {
  const f = fixture();
  // A missing config demonstrates that consent is checked before config IO.
  const install = runInstaller(['--config', path.join(f.directory, 'missing.json'), '--state-dir', f.stateDir, '--plist-dir', f.plistDir]);
  assert.equal(install.status, 1);
  assert.match(install.stderr, /without --apply/);
  assert.equal(existsSync(f.stateDir), false);
  assert.equal(existsSync(f.plistDir), false);

  mkdirSync(f.plistDir);
  const plist = path.join(f.plistDir, `${LABEL}.plist`);
  writeFileSync(plist, 'sentinel\n');
  const uninstall = runInstaller(['--uninstall', '--state-dir', f.stateDir, '--plist-dir', f.plistDir]);
  assert.equal(uninstall.status, 1);
  assert.match(uninstall.stderr, /without --apply/);
  assert.equal(existsSync(plist), true);
  assert.equal(existsSync(f.stateDir), false);
});

test('dry-run takes precedence over --apply for install and uninstall', () => {
  const f = fixture();
  const install = runInstaller(['--apply', '--dry-run', ...baseArgs(f)]);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(parsePlan(install.stdout).dry_run, true);
  const uninstall = runInstaller(['--apply', '--dry-run', '--uninstall', '--plist-dir', f.plistDir, '--state-dir', f.stateDir]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(parsePlan(uninstall.stdout).uninstall, true);
  assert.equal(existsSync(f.plistDir), false);
  assert.equal(existsSync(f.stateDir), false);
});

test('managed state and plist symlinks reject install and uninstall before side effects', () => {
  const f = fixture();
  // Resolve macOS /var system alias; the tested links below are user-created.
  const directory = realpathSync(f.directory);
  const legacy = path.join(directory, 'legacy');
  const state = path.join(directory, 'redirected-state');
  const agents = path.join(directory, 'agents');
  mkdirSync(legacy); mkdirSync(agents);
  const sentinel = path.join(legacy, 'sentinel');
  writeFileSync(sentinel, 'unchanged');
  symlinkSync(legacy, state);
  for (const uninstall of [false, true]) {
    const args = ['--apply', '--state-dir', state, '--plist-dir', agents, ...(uninstall ? ['--uninstall'] : [])];
    assert.throws(() => preflightManagedPaths(parseOptions(args)), /symlink/);
    if (process.platform === 'darwin') {
      const result = runInstaller(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /symlink/);
      assert.doesNotMatch(result.stderr, /Test blocked/);
    }
  }
  rmSync(state); mkdirSync(state);
  symlinkSync(sentinel, path.join(state, 'run.log'));
  assert.throws(() => preflightManagedPaths(parseOptions(['--apply', '--state-dir', state, '--plist-dir', agents])), /symlink/);
  rmSync(path.join(state, 'run.log'));
  symlinkSync(sentinel, path.join(agents, `${LABEL}.plist`));
  assert.throws(() => preflightManagedPaths(parseOptions(['--apply', '--uninstall', '--state-dir', state, '--plist-dir', agents])), /symlink/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('default job and paths are isolated from legacy services', () => {
  const options = parseOptions(['--knowledge-source', 'demo']);
  assert.equal(LABEL, 'local.agent-observatory.agent-journal');
  assert.equal(options.stateDir, path.join(os.homedir(), '.local/share/agent-observatory/agent-journal'));
  assert.equal(options.configPath, path.join(options.stateDir, 'journal.json'));
  assert.equal(options.tokenFile, path.join(options.stateDir, 'content.token'));
  assert.equal(options.keyFile, path.join(options.stateDir, 'deepseek.key'));
  assert.equal(options.knowledge?.configPath, path.join(os.homedir(), '.local/share/agent-observatory/agent-knowledge/content.json'));
  assert.equal(options.plistPath, path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`));
  assert.notEqual(options.plistPath, path.join(os.homedir(), 'Library/LaunchAgents/local.agent-journal.plist'));
  assert.equal(options.apply, false);
});

test('generated wrapper fails safely when the token or key file is missing', () => {
  const f = fixture();
  const plan = parsePlan(runInstaller(['--dry-run', ...baseArgs(f)]).stdout);
  const wrapperPath = plan.wrapper_path as string;
  mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  writeFileSync(wrapperPath, plan.wrapper as string, { mode: 0o600 });

  // Missing token: clear message, nonzero exit, nothing logged yet, no secret echoed.
  rmSync(f.tokenFile);
  const missingToken = spawnSync('/bin/sh', [wrapperPath], { env: { ...process.env, HOME: f.directory }, encoding: 'utf8' });
  assert.equal(missingToken.status, 1);
  assert.match(missingToken.stderr, /Trace token file is missing or empty/);
  assert.equal(missingToken.stderr.includes(TOKEN_SENTINEL), false);
  assert.equal(missingToken.stderr.includes(KEY_SENTINEL), false);
  assert.equal(existsSync(path.join(f.stateDir, 'run.log')), false);

  // Token present, key missing: token is exported into the child env only, never printed.
  writeFileSync(f.tokenFile, `${TOKEN_SENTINEL}\n`, { mode: 0o600 });
  rmSync(f.keyFile);
  const missingKey = spawnSync('/bin/sh', [wrapperPath], { env: { ...process.env, HOME: f.directory }, encoding: 'utf8' });
  assert.equal(missingKey.status, 1);
  assert.match(missingKey.stderr, /API key file is missing or empty/);
  assert.equal(`${missingKey.stdout}${missingKey.stderr}`.includes(TOKEN_SENTINEL), false);
  assert.equal(`${missingKey.stdout}${missingKey.stderr}`.includes(KEY_SENTINEL), false);
});

test('exported helpers build the job the installer uses', () => {
  const options = parseOptions([
    '--config', '/tmp/journal.json',
    '--state-dir', '/tmp/state',
    '--plist-dir', '/tmp/LaunchAgents',
  ]);
  const job = buildJob(options);
  assert.equal(job.Label, LABEL);
  assert.deepEqual(job.ProgramArguments, ['/bin/sh', '/tmp/state/run.sh']);
  assert.deepEqual(job.StartCalendarInterval, { Hour: 6, Minute: 30 });
  assert.equal(job.RunAtLoad, false);
  assert.equal(job.StandardOutPath, '/tmp/state/run.log');
  assert.equal(job.StandardErrorPath, '/tmp/state/run.err');
  assert.equal(options.plistPath, `/tmp/LaunchAgents/${LABEL}.plist`);
  assert.equal(options.wrapperPath, '/tmp/state/run.sh');
  assert.equal(options.retries, 1);
  assert.equal(options.knowledge, null);
});
