#!/usr/bin/env node
/**
 * Install the long-running content-capture services for one macOS user.
 *
 * - `local.agent-observatory.trace-content` : isolated Trace service
 * - `local.agent-observatory.knowledge-follow` (optional): Knowledge's follow worker, so
 *   captured pages keep flowing into the evidence database without babysitting.
 *
 * The installer never enables capture by itself: the config must already be
 * `capture_mode: "content"` and have collection enabled. It prunes blob files
 * that no committed event cites before starting the service, then leaves both
 * jobs to launchd (`RunAtLoad` + `KeepAlive`).
 *
 * Usage:
 *   node --experimental-strip-types scripts/install-content-service.ts [options]
 *     --config PATH          service config (default ~/.local/share/agent-observatory/agent-trace/content.json)
 *     --token-file PATH      API token (default ~/.local/share/agent-observatory/agent-trace/content.token)
 *     --knowledge-follow P   Knowledge config (default ~/.local/share/agent-observatory/agent-knowledge/content.follow.json)
 *     --knowledge-dir PATH   Knowledge checkout (default ../agent-knowledge)
 *     --no-knowledge         install only the Trace content service
 *     --uninstall            stop and remove selected isolated jobs
 *     --dry-run              print paths and labels without accessing launchd or configuration
 *     --apply                explicitly authorize installation or uninstallation
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TRACE_LABEL = 'local.agent-observatory.trace-content';
export const KNOWLEDGE_LABEL = 'local.agent-observatory.knowledge-follow';
const NODE = process.execPath;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(file: string, args: string[], capture = true): { code: number; out: string; err: string } {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

function check(what: string, result: { code: number; err: string }): void {
  if (result.code !== 0) fail(`${what} failed: ${result.err.trim() || `exit ${result.code}`}`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function loaded(label: string): boolean {
  return run('/bin/launchctl', ['print', `${domain()}/${label}`]).code === 0;
}

/** Write a plist through plutil so escaping and format are Apple's problem. */
function writePlist(label: string, value: Record<string, unknown>, target: string): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-trace-plist-'));
  try {
    const json = path.join(dir, 'service.json');
    writeFileSync(json, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const pending = `${target}.pending`;
    check(`plutil ${label}`, run('/usr/bin/plutil', ['-convert', 'xml1', '-o', pending, json]));
    chmodSync(pending, 0o600);
    check(`plutil -lint ${label}`, run('/usr/bin/plutil', ['-lint', pending]));
    check(`install ${label}`, run('/bin/mv', ['-f', pending, target]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function bootout(label: string): void {
  if (!loaded(label)) return;
  check(`launchctl bootout ${label}`, run('/bin/launchctl', ['bootout', `${domain()}/${label}`]));
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!loaded(label)) return;
    execFileSync('/bin/sleep', ['0.1']);
  }
  fail(`${label} did not stop`);
}

function bootstrap(label: string, target: string): void {
  check(`launchctl enable ${label}`, run('/bin/launchctl', ['enable', `${domain()}/${label}`]));
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = run('/bin/launchctl', ['bootstrap', domain(), target]);
    if (result.code === 0 || loaded(label)) return;
    execFileSync('/bin/sleep', ['0.25']);
  }
  fail(`launchctl bootstrap ${label} failed`);
}

/** Create the log file (0600) without truncating the previous run. */
function touch(file: string): void {
  appendFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o600);
}

const OPTIONS = {
  config: { type: 'string' as const },
  'token-file': { type: 'string' as const },
  'knowledge-follow': { type: 'string' as const },
  'knowledge-dir': { type: 'string' as const },
  'no-knowledge': { type: 'boolean' as const },
  uninstall: { type: 'boolean' as const },
  'dry-run': { type: 'boolean' as const },
  apply: { type: 'boolean' as const },
};

/** Pure planning and authorization: no config, token, subprocess or filesystem access. */
export function planInstaller(args: string[], home: string, root: string) {
  const { values } = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false });
  const dryRun = values['dry-run'] === true;
  if (dryRun && values.apply === true) throw new Error('--dry-run and --apply are mutually exclusive');
  if (!dryRun && values.apply !== true) throw new Error('Refusing to modify services: use --dry-run to inspect, then --apply to authorize');
  const traceState = path.join(home, '.local/share/agent-observatory/agent-trace');
  const knowledgeState = path.join(home, '.local/share/agent-observatory/agent-knowledge');
  const agents = path.join(home, 'Library/LaunchAgents');
  return {
    action: values.uninstall === true ? 'uninstall' as const : 'install' as const,
    dryRun,
    withKnowledge: values['no-knowledge'] !== true,
    traceState,
    knowledgeState,
    agents,
    config: path.resolve(values.config ?? path.join(traceState, 'content.json')),
    tokenFile: path.resolve(values['token-file'] ?? path.join(traceState, 'content.token')),
    followConfig: path.resolve(values['knowledge-follow'] ?? path.join(knowledgeState, 'content.follow.json')),
    knowledgeDir: path.resolve(values['knowledge-dir'] ?? path.join(root, '..', 'agent-knowledge')),
    traceLabel: TRACE_LABEL,
    knowledgeLabel: KNOWLEDGE_LABEL,
    tracePlist: path.join(agents, `${TRACE_LABEL}.plist`),
    knowledgePlist: path.join(agents, `${KNOWLEDGE_LABEL}.plist`),
  };
}

/** Check every existing component without following user-controlled symlinks. */
function safePath(target: string, kind: 'file' | 'directory'): void {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) {
      // macOS exposes these system-level compatibility aliases on clean installs.
      if (index === 0 && ['var', 'tmp', 'etc'].includes(part)
          && realpathSync(current) === `/private/${part}`) continue;
      throw new Error(`Refusing symlink in managed path: ${current}`);
    }
    const expectedDirectory = index < parts.length - 1 || kind === 'directory';
    if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Unexpected type in managed path: ${current}`);
    }
  }
}

export function preflightManagedPaths(plan: ReturnType<typeof planInstaller>): void {
  safePath(plan.traceState, 'directory');
  if (plan.withKnowledge) safePath(plan.knowledgeState, 'directory');
  safePath(plan.agents, 'directory');
  for (const plist of [plan.tracePlist, ...(plan.withKnowledge ? [plan.knowledgePlist] : [])]) {
    safePath(plist, 'file');
    safePath(`${plist}.pending`, 'file');
    if (existsSync(`${plist}.pending`)) throw new Error(`Pending plist already exists: ${plist}.pending`);
  }
  if (plan.action === 'install') {
    for (const name of ['content.log', 'content.err', 'content.json', 'content.token']) safePath(path.join(plan.traceState, name), 'file');
    if (plan.withKnowledge) for (const name of ['follow.log', 'follow.err', 'content.follow.json']) safePath(path.join(plan.knowledgeState, name), 'file');
  }
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let plan: ReturnType<typeof planInstaller>;
  try { plan = planInstaller(process.argv.slice(2), os.homedir(), root); }
  catch (error) { fail((error as Error).message); }
  // Planning intentionally does not read config/token or invoke even read-only launchctl.
  if (plan.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (process.platform !== 'darwin') fail('This installer requires macOS');
  const { traceState, knowledgeState, agents, config, tokenFile, followConfig, knowledgeDir,
    withKnowledge, tracePlist, knowledgePlist } = plan;
  try { preflightManagedPaths(plan); } catch (error) { fail((error as Error).message); }

  if (plan.action === 'uninstall') {
    bootout(TRACE_LABEL);
    if (withKnowledge) bootout(KNOWLEDGE_LABEL);
    for (const file of [tracePlist, ...(withKnowledge ? [knowledgePlist] : [])]) if (existsSync(file)) rmSync(file);
    process.stdout.write('Removed the content capture jobs; databases and logs are untouched.\n');
    return;
  }

  if (!existsSync(config)) fail(`Missing content service config: ${config}`);
  const describe = run(NODE, ['--experimental-strip-types', path.join(root, 'src/cli.ts'),
    'config-check', '--config', config]);
  check('config-check', describe);
  const described = JSON.parse(describe.out) as { capture_mode: string; collection: { enabled: boolean; backfill: string } };
  if (described.capture_mode !== 'content') fail(`${config} is not a content capture config`);
  if (!described.collection.enabled) fail(`${config} has collection.enabled = false`);

  const traceLog = path.join(traceState, 'content.log');
  const traceErr = path.join(traceState, 'content.err');
  const traceJob = {
    Label: TRACE_LABEL,
    ProgramArguments: [NODE, '--experimental-strip-types', path.join(root, 'src/cli.ts'), 'serve', '--config', config],
    WorkingDirectory: traceState,
    EnvironmentVariables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 30,
    ProcessType: 'Background',
    StandardOutPath: traceLog,
    StandardErrorPath: traceErr,
  };

  let knowledgeJob: Record<string, unknown> | null = null;
  if (withKnowledge) {
    const cli = path.join(knowledgeDir, 'dist/interfaces/cli.js');
    if (!existsSync(cli)) fail(`Knowledge build missing: ${cli} (run npm run build in ${knowledgeDir}, or pass --no-knowledge)`);
    if (!existsSync(followConfig)) fail(`Missing Knowledge follow config: ${followConfig} (or pass --no-knowledge)`);
    if (!existsSync(tokenFile)) fail(`Missing API token file: ${tokenFile} (or pass --no-knowledge)`);
    const follow = JSON.parse(readFileSync(followConfig, 'utf8')) as { token_env?: string };
    if (!follow.token_env) fail(`${followConfig} does not declare token_env`);
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (!token) fail(`Empty API token: ${tokenFile}`);
    knowledgeJob = {
      Label: KNOWLEDGE_LABEL,
      ProgramArguments: [NODE, cli, 'follow', '--config', followConfig],
      WorkingDirectory: knowledgeDir,
      EnvironmentVariables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', [follow.token_env]: token },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 30,
      ProcessType: 'Background',
      StandardOutPath: path.join(knowledgeState, 'follow.log'),
      StandardErrorPath: path.join(knowledgeState, 'follow.err'),
    };
  }

  // Configuration and credentials have been validated before any filesystem mutation.
  mkdirSync(traceState, { recursive: true, mode: 0o700 });
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  touch(traceLog);
  touch(traceErr);
  if (knowledgeJob) {
    mkdirSync(knowledgeState, { recursive: true, mode: 0o700 });
    touch(path.join(knowledgeState, 'follow.log'));
    touch(path.join(knowledgeState, 'follow.err'));
  }

  // Stop first: gc must not race a scan that is still writing blobs.
  bootout(TRACE_LABEL);
  if (withKnowledge) bootout(KNOWLEDGE_LABEL);
  check('blob gc', run(NODE, ['--experimental-strip-types', path.join(root, 'src/cli.ts'), 'gc', '--config', config]));
  writePlist(TRACE_LABEL, traceJob, tracePlist);
  bootstrap(TRACE_LABEL, tracePlist);
  if (knowledgeJob) {
    writePlist(KNOWLEDGE_LABEL, knowledgeJob, knowledgePlist);
    bootstrap(KNOWLEDGE_LABEL, knowledgePlist);
  }
  process.stdout.write([
    `Started ${TRACE_LABEL} (content capture)`,
    knowledgeJob ? `Started ${KNOWLEDGE_LABEL} (Trace -> Knowledge follow)` : 'Knowledge follow not installed',
    `Trace log: ${traceLog}`,
    `Knowledge log: ${path.join(knowledgeState, 'follow.log')}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
