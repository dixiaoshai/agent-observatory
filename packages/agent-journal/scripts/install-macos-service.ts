#!/usr/bin/env node
/**
 * Install the daily `agent-journal run` launchd job for one macOS user.
 *
 * The job has no secrets: the plist just starts a generated `run.sh` wrapper
 * (`local.agent-observatory.agent-journal`, `StartCalendarInterval` 06:30, `RunAtLoad` false).
 * The wrapper reads the Trace token and the model API key from 0600 files at
 * run time, exports them only into the child process, then runs
 * `dist/cli.js run --config <abs journal.json>` and, optionally, a separate
 * `agent-knowledge sync --source <id>` step.
 *
 * Usage:
 *   node --experimental-strip-types scripts/install-macos-service.ts [options]
 *     --config PATH              journal config (default <state-dir>/journal.json)
 *     --state-dir PATH           state/log directory (default ~/.local/share/agent-observatory/agent-journal)
 *     --plist-dir PATH           LaunchAgents directory (default ~/Library/LaunchAgents)
 *     --token-file PATH          Trace token file, 0600 (default <state-dir>/content.token)
 *     --deepseek-key-file PATH   model API key file, 0600 (default <state-dir>/deepseek.key)
 *     --retries N                transient retries, 0..5 (default 1)
 *     --knowledge-dir PATH       Knowledge checkout (default <repo>/../agent-knowledge)
 *     --knowledge-config PATH    Knowledge config (default ~/.local/share/agent-observatory/agent-knowledge/content.json)
 *     --knowledge-source ID      also run `agent-knowledge sync --source ID`
 *     --skip-token-check         do not probe Trace /v1/status during install
 *     --dry-run                  print the plan as JSON; touch nothing
 *     --apply                    explicitly authorize install or uninstall
 *     --uninstall                bootout the job and remove the plist; keep state/logs
 *     --help                     show this message
 *
 * Reinstalling is idempotent: an already loaded job is booted out first, then
 * the plist is written atomically and bootstrapped again.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import type { JournalConfig } from '../src/config.ts';

export const LABEL = 'local.agent-observatory.agent-journal';
const SCHEDULE_HOUR = 6;
const SCHEDULE_MINUTE = 30;
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const LAUNCHCTL = '/bin/launchctl';
const PLUTIL = '/usr/bin/plutil';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Absolute Node used by launchd; fixed at install time so nvm shell setup is unnecessary. */
const NODE = process.execPath;
const TOKEN_CHECK_TIMEOUT_MS = 10_000;
const RETRY_SLEEPS_SECONDS = [30, 120] as const;

export const HELP = `Agent Journal: install the daily 06:30 launchd job (macOS)

Usage: node --experimental-strip-types scripts/install-macos-service.ts [options]

Options:
  --config PATH              journal config (default <state-dir>/journal.json)
  --state-dir PATH           state/log directory (default ~/.local/share/agent-observatory/agent-journal)
  --plist-dir PATH           LaunchAgents directory (default ~/Library/LaunchAgents)
  --token-file PATH          Trace token file, 0600 (default <state-dir>/content.token)
  --deepseek-key-file PATH   model API key file, 0600 (default <state-dir>/deepseek.key)
  --retries N                transient retries, 0..5 (default 1)
  --knowledge-dir PATH       Knowledge checkout (default <repo>/../agent-knowledge)
  --knowledge-config PATH    Knowledge config (default ~/.local/share/agent-observatory/agent-knowledge/content.json)
  --knowledge-source ID      also run \`agent-knowledge sync --source ID\`
  --skip-token-check         do not probe Trace /v1/status during install
  --dry-run                  print the plan as JSON; touch nothing
  --apply                    explicitly authorize install or uninstall
  --uninstall                bootout the job and remove the plist; keep state/logs
  --help                     show this message

Install and uninstall require --apply. --dry-run never mutates even with --apply.
Explicit config, state and secret paths may point at real user data: review them
before applying. The service uses an isolated label but does not isolate an
explicitly supplied database, output directory or upstream service.
The plist never contains secrets: the generated wrapper reads the token and API
key files (0600) at run time. Single-instance protection is the SQLite lease;
FOLLOW_LOCKED from a concurrent run is treated as benign and exits 0.
`;

export class InstallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallerError';
  }
}

export interface KnowledgeStep {
  dir: string;
  cli: string;
  configPath: string;
  source: string;
}

export interface InstallerOptions {
  repoRoot: string;
  configPath: string;
  stateDir: string;
  plistDir: string;
  tokenFile: string;
  keyFile: string;
  retries: number;
  knowledge: KnowledgeStep | null;
  dryRun: boolean;
  apply: boolean;
  uninstall: boolean;
  skipTokenCheck: boolean;
  help: boolean;
  wrapperPath: string;
  plistPath: string;
  logPath: string;
  errorLogPath: string;
}

export interface ServiceJob {
  Label: string;
  ProgramArguments: string[];
  WorkingDirectory: string;
  EnvironmentVariables: Record<string, string>;
  RunAtLoad: false;
  StartCalendarInterval: { Hour: number; Minute: number };
  ProcessType: 'Background';
  StandardOutPath: string;
  StandardErrorPath: string;
}

const OPTION_DEFS = {
  config: { type: 'string' },
  'state-dir': { type: 'string' },
  'plist-dir': { type: 'string' },
  'token-file': { type: 'string' },
  'deepseek-key-file': { type: 'string' },
  retries: { type: 'string' },
  'knowledge-config': { type: 'string' },
  'knowledge-source': { type: 'string' },
  'knowledge-dir': { type: 'string' },
  'dry-run': { type: 'boolean' },
  apply: { type: 'boolean' },
  uninstall: { type: 'boolean' },
  'skip-token-check': { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

function parseArgsStrict(args: string[]) {
  try {
    return parseArgs({ args, options: OPTION_DEFS, strict: true, allowPositionals: false });
  } catch (error) {
    throw new InstallerError(`Invalid arguments: ${(error as Error).message}`);
  }
}

function parseRetries(raw: string | undefined): number {
  if (raw === undefined) return 1;
  if (!/^[0-5]$/.test(raw)) {
    throw new InstallerError(`Invalid --retries ${JSON.stringify(raw)}: expected an integer between 0 and 5.`);
  }
  return Number(raw);
}

/** Resolve flags into absolute paths plus the derived launchd paths. Pure (no disk writes). */
export function parseOptions(args: string[]): InstallerOptions {
  const { values } = parseArgsStrict(args);
  const home = os.homedir();
  const stateDir = path.resolve(values['state-dir'] ?? path.join(home, '.local/share/agent-observatory/agent-journal'));
  const plistDir = path.resolve(values['plist-dir'] ?? path.join(home, 'Library/LaunchAgents'));
  const configPath = path.resolve(values.config ?? path.join(stateDir, 'journal.json'));
  const tokenFile = path.resolve(values['token-file'] ?? path.join(stateDir, 'content.token'));
  const keyFile = path.resolve(values['deepseek-key-file'] ?? path.join(stateDir, 'deepseek.key'));
  const knowledgeDir = path.resolve(values['knowledge-dir'] ?? path.join(REPO_ROOT, '..', 'agent-knowledge'));

  const source = values['knowledge-source'];
  if (source !== undefined && source.trim() !== source) {
    throw new InstallerError(`Invalid --knowledge-source ${JSON.stringify(source)}: expected a non-empty source id.`);
  }
  if (source === '') {
    throw new InstallerError('Invalid --knowledge-source: expected a non-empty source id.');
  }
  const knowledge: KnowledgeStep | null = source === undefined ? null : {
    dir: knowledgeDir,
    cli: path.join(knowledgeDir, 'dist/interfaces/cli.js'),
    configPath: path.resolve(values['knowledge-config'] ?? path.join(home, '.local/share/agent-observatory/agent-knowledge/content.json')),
    source,
  };

  return {
    repoRoot: REPO_ROOT,
    configPath,
    stateDir,
    plistDir,
    tokenFile,
    keyFile,
    retries: parseRetries(values.retries),
    knowledge,
    dryRun: values['dry-run'] === true,
    apply: values.apply === true,
    uninstall: values.uninstall === true,
    skipTokenCheck: values['skip-token-check'] === true,
    help: values.help === true,
    wrapperPath: path.join(stateDir, 'run.sh'),
    plistPath: path.join(plistDir, `${LABEL}.plist`),
    logPath: path.join(stateDir, 'run.log'),
    errorLogPath: path.join(stateDir, 'run.err'),
  };
}

/** Quote one shell word safely (paths may contain spaces or quotes). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** The launchd property list. Contains paths and a minimal PATH only: never secrets. */
export function buildJob(options: InstallerOptions): ServiceJob {
  return {
    Label: LABEL,
    ProgramArguments: ['/bin/sh', options.wrapperPath],
    WorkingDirectory: options.repoRoot,
    EnvironmentVariables: { PATH: BASE_PATH },
    RunAtLoad: false,
    StartCalendarInterval: { Hour: SCHEDULE_HOUR, Minute: SCHEDULE_MINUTE },
    ProcessType: 'Background',
    StandardOutPath: options.logPath,
    StandardErrorPath: options.errorLogPath,
  };
}

/** Build the 0600 wrapper shell script that launchd invokes as `/bin/sh run.sh`. */
export function buildWrapper(options: InstallerOptions, config: JournalConfig): string {
  const q = shellQuote;
  const lines: string[] = [
    '#!/bin/sh',
    '# Generated by agent-journal scripts/install-macos-service.ts -- do not edit by hand.',
    '# The plist contains no secrets: the Trace token and model API key are read from',
    '# 0600 files at run time and exported only into the child process environment.',
    'set -u',
    'umask 077',
    '',
    `NODE=${q(NODE)}`,
    `PATH=${q(`${path.dirname(NODE)}:${BASE_PATH}`)}`,
    'export PATH',
    `CONFIG=${q(options.configPath)}`,
    `STATE_DIR=${q(options.stateDir)}`,
    `TOKEN_FILE=${q(options.tokenFile)}`,
    `LOG=${q(options.logPath)}`,
    `CLI=${q(path.join(options.repoRoot, 'dist/cli.js'))}`,
    `RETRIES=${String(options.retries)}`,
  ];
  if (config.model) lines.push(`KEY_FILE=${q(options.keyFile)}`);
  if (options.knowledge) {
    lines.push(
      `KNOWLEDGE_CLI=${q(options.knowledge.cli)}`,
      `KNOWLEDGE_CONFIG=${q(options.knowledge.configPath)}`,
      `KNOWLEDGE_SOURCE=${q(options.knowledge.source)}`,
    );
  }
  lines.push(
    '',
    "log() { printf '%s %s\\n' \"$(date '+%Y-%m-%dT%H:%M:%S%z')\" \"$*\" >> \"$LOG\"; }",
    "step() { printf '\\n===== %s %s =====\\n' \"$1\" \"$(date '+%Y-%m-%dT%H:%M:%S%z')\" >> \"$LOG\"; }",
    '',
    '# Secrets: read at run time, never stored in the plist or in this wrapper.',
    'if [ ! -f "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then',
    "  printf 'agent-journal: Trace token file is missing or empty: %s\\n' \"$TOKEN_FILE\" >&2",
    '  exit 1',
    'fi',
    `${config.tokenEnv}="$(cat "$TOKEN_FILE")"`,
    `export ${config.tokenEnv}`,
  );
  if (config.model) {
    lines.push(
      'if [ ! -f "$KEY_FILE" ] || [ ! -s "$KEY_FILE" ]; then',
      "  printf 'agent-journal: model API key file is missing or empty: %s\\n' \"$KEY_FILE\" >&2",
      '  exit 1',
      'fi',
      `${config.model.apiKeyEnv}="$(cat "$KEY_FILE")"`,
      `export ${config.model.apiKeyEnv}`,
    );
  }
  lines.push(
    '',
    'TMP_ERR="$(mktemp "$STATE_DIR/.run-stderr.XXXXXX")" || {',
    "  printf 'agent-journal: cannot create a temporary stderr file under %s\\n' \"$STATE_DIR\" >&2",
    '  exit 1',
    '}',
    "trap 'rm -f \"$TMP_ERR\"' EXIT HUP INT TERM",
    '',
    'JOURNAL_EXIT=1',
    'KNOWLEDGE_EXIT=0',
    'ATTEMPT=0',
    '',
    'step "journal run"',
    'while :; do',
    '  if "$NODE" "$CLI" run --config "$CONFIG" >> "$LOG" 2> "$TMP_ERR"; then',
    '    JOURNAL_EXIT=0',
    '    log "journal run: succeeded"',
    '    break',
    '  fi',
    '  JOURNAL_EXIT=1',
    '  # A held lease is a benign concurrent run: log it without forwarding the',
    '  # error JSON to run.err, so launchd error logs stay actionable.',
    '  LAST_LINE="$(tail -n 1 "$TMP_ERR")"',
    '  case "$LAST_LINE" in',
    "    *'\"code\":\"FOLLOW_LOCKED\"'*)",
    '      log "journal run: already running, skipped"',
    '      JOURNAL_EXIT=0',
    '      break',
    '      ;;',
    '  esac',
    '  cat "$TMP_ERR" >&2',
    '  IS_TRANSIENT=0',
    '  case "$LAST_LINE" in',
    "    *'\"class\":\"transient\"'*) IS_TRANSIENT=1 ;;",
    '  esac',
    '  if [ "$IS_TRANSIENT" -eq 1 ] && [ "$ATTEMPT" -lt "$RETRIES" ]; then',
    '    ATTEMPT=$((ATTEMPT + 1))',
    "    if [ \"$ATTEMPT\" -eq 1 ]; then SLEEP=30; else SLEEP=120; fi",
    '    log "journal run: transient failure, retry $ATTEMPT/$RETRIES in ${SLEEP}s"',
    '    sleep "$SLEEP"',
    '    : > "$TMP_ERR"',
    '    step "journal run retry $ATTEMPT"',
    '    continue',
    '  fi',
    '  if [ "$IS_TRANSIENT" -eq 1 ]; then',
    '    log "journal run: transient failure, retries exhausted"',
    '  else',
    '    log "journal run: failed, not retried"',
    '  fi',
    '  break',
    'done',
  );
  if (options.knowledge) {
    lines.push(
      '',
      'if [ "$JOURNAL_EXIT" -eq 0 ]; then',
      '  step "knowledge sync"',
      '  if "$NODE" "$KNOWLEDGE_CLI" sync --source "$KNOWLEDGE_SOURCE" --config "$KNOWLEDGE_CONFIG" >> "$LOG" 2>&1; then',
      '    log "knowledge sync: succeeded"',
      '  else',
      '    log "knowledge sync: failed"',
      '    KNOWLEDGE_EXIT=1',
      '  fi',
      'fi',
    );
  }
  lines.push(
    '',
    'if [ "$JOURNAL_EXIT" -ne 0 ]; then exit 1; fi',
    'if [ "$KNOWLEDGE_EXIT" -ne 0 ]; then exit 1; fi',
    'exit 0',
    '',
  );
  return lines.join('\n');
}

export function installCommands(options: InstallerOptions): string[] {
  const domain = launchdDomain();
  const pending = `${options.plistPath}.pending`;
  return [
    `${LAUNCHCTL} bootout ${domain}/${LABEL}   # only when the job is already loaded`,
    `${LAUNCHCTL} enable ${domain}/${LABEL}`,
    `${PLUTIL} -convert xml1 -o ${shellQuote(pending)} <temporary service.json>`,
    `chmod 0600 ${shellQuote(pending)}`,
    `${PLUTIL} -lint ${shellQuote(pending)}`,
    `/bin/mv -f ${shellQuote(pending)} ${shellQuote(options.plistPath)}`,
    `${LAUNCHCTL} bootstrap ${domain} ${shellQuote(options.plistPath)}`,
    `${LAUNCHCTL} kickstart -k ${domain}/${LABEL}   # manual first run`,
  ];
}

export function uninstallCommands(options: InstallerOptions): string[] {
  return [
    `${LAUNCHCTL} bootout ${launchdDomain()}/${LABEL}`,
    `/bin/rm -f ${shellQuote(options.plistPath)}`,
  ];
}

/** The `--dry-run` payload for an install. Contains no token or key values by construction. */
export function buildInstallPlan(options: InstallerOptions, config: JournalConfig): Record<string, unknown> {
  const notes = [
    'Dry run only: nothing was created and launchctl/plutil were not invoked.',
    'RunAtLoad is false; launchd runs the job daily at 06:30 local time.',
    'The plist contains no secrets; the wrapper reads 0600 files at run time.',
    `Transient CLI failures are retried ${options.retries} time(s) with 30s/120s backoff; FOLLOW_LOCKED is benign.`,
    options.knowledge
      ? `After the journal step: sync --source ${options.knowledge.source} using ${options.knowledge.cli}.`
      : 'Knowledge sync is not included (no --knowledge-source).',
    'Real install requires dist/cli.js; run "npm run build" first.',
  ];
  return {
    dry_run: true,
    label: LABEL,
    plist_path: options.plistPath,
    plist: buildJob(options),
    wrapper_path: options.wrapperPath,
    wrapper: buildWrapper(options, config),
    commands: installCommands(options),
    notes,
  };
}

/** The `--uninstall --dry-run` payload: prints the plan, changes nothing. */
export function buildUninstallPlan(options: InstallerOptions): Record<string, unknown> {
  return {
    dry_run: true,
    uninstall: true,
    label: LABEL,
    plist_path: options.plistPath,
    commands: uninstallCommands(options),
  };
}

function loadJournalConfig(configPath: string): JournalConfig {
  if (!existsSync(configPath)) {
    throw new InstallerError(`Missing configuration: ${configPath} (pass --config PATH)`);
  }
  try {
    return loadConfig(configPath);
  } catch (error) {
    throw new InstallerError(`Invalid configuration ${configPath}: ${(error as Error).message}`);
  }
}

function validateKnowledge(options: InstallerOptions): void {
  if (!options.knowledge) return;
  if (!existsSync(options.knowledge.cli)) {
    throw new InstallerError(
      `Knowledge build missing: ${options.knowledge.cli} (run "npm run build" in ${options.knowledge.dir}, or drop --knowledge-source)`,
    );
  }
  if (!existsSync(options.knowledge.configPath)) {
    throw new InstallerError(
      `Missing Knowledge config: ${options.knowledge.configPath} (pass --knowledge-config PATH or drop --knowledge-source)`,
    );
  }
}

function safeManagedPath(target: string, kind: 'file' | 'directory'): void {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) {
      if (index === 0 && ['var', 'tmp', 'etc'].includes(part)
          && realpathSync(current) === `/private/${part}`) continue;
      throw new InstallerError(`Refusing symlink in managed path: ${current}`);
    }
    const expectedDirectory = index < parts.length - 1 || kind === 'directory';
    if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw new InstallerError(`Unexpected type in managed path: ${current}`);
    }
  }
}

/** Read-only preflight before any launchctl call, chmod, file writes or network. */
export function preflightManagedPaths(options: InstallerOptions): void {
  safeManagedPath(options.stateDir, 'directory');
  safeManagedPath(options.plistDir, 'directory');
  safeManagedPath(options.plistPath, 'file');
  safeManagedPath(`${options.plistPath}.pending`, 'file');
  if (existsSync(`${options.plistPath}.pending`)) throw new InstallerError(`Pending plist already exists: ${options.plistPath}.pending`);
  if (!options.uninstall) {
    for (const file of [options.wrapperPath, options.logPath, options.errorLogPath,
      options.tokenFile, options.keyFile]) safeManagedPath(file, 'file');
    // Explicit external config/database paths are trusted choices; a default
    // config under the managed state directory must not be redirected.
    if (options.configPath === path.join(options.stateDir, 'journal.json')) safeManagedPath(options.configPath, 'file');
  }
}

function ensureStateDirectory(options: InstallerOptions): void {
  if (!existsSync(options.stateDir)) mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(options.stateDir, 0o700);
}

function ensureSecretMode(file: string, what: string): void {
  if ((statSync(file).mode & 0o777) === 0o600) return;
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    throw new InstallerError(`Cannot chmod 0600 ${what} file ${file}: ${(error as Error).message}`);
  }
}

function readSecretIfPresent(file: string, what: string): string | null {
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  if (!value) return null;
  ensureSecretMode(file, what);
  return value;
}

function readSecretFile(file: string, what: string): string {
  const value = readSecretIfPresent(file, what);
  if (value === null) throw new InstallerError(`Missing or empty ${what} file: ${file}`);
  return value;
}

/** Create <state-dir>/deepseek.key from the config's api key env when the file is absent. */
function ensureModelKeyFile(options: InstallerOptions, config: JournalConfig): boolean {
  if (!config.model) return false;
  if (readSecretIfPresent(options.keyFile, 'model API key') !== null) return false;
  const fromEnv = process.env[config.model.apiKeyEnv];
  if (typeof fromEnv !== 'string' || !fromEnv.trim()) {
    throw new InstallerError(
      `Missing model API key file: ${options.keyFile}\n` +
      `Create it with 0600 permissions, or export ${config.model.apiKeyEnv} before installing.`,
    );
  }
  writeFileSync(options.keyFile, `${fromEnv.trim()}\n`, { mode: 0o600 });
  chmodSync(options.keyFile, 0o600);
  return true;
}

async function probeTrace(config: JournalConfig, token: string): Promise<void> {
  const url = `${config.traceUrl}/v1/status`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    process.stderr.write(`warning: could not reach Trace at ${url} (${(error as Error).message}); continuing anyway.\n`);
    return;
  }
  await response.text().catch(() => '');
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new InstallerError(
      `Trace rejected the token at ${url} (HTTP ${response.status}).\n` +
      'In the Trace content config add an api.clients entry for agent-journal ' +
      '({"id":"agent-journal","views":["content"],"token_sha256":"<sha256 of the token>"}), ' +
      'restart the content service, then retry.',
    );
  }
  process.stderr.write(`warning: Trace status check at ${url} returned HTTP ${response.status}; continuing anyway.\n`);
}

/** Create the log file (0600) without truncating a previous run. */
function touchLog(file: string): void {
  appendFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o600);
}

function runCommand(file: string, args: string[]): { status: number; stderr: string } {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

function sleepSeconds(seconds: number): void {
  spawnSync('/bin/sleep', [String(seconds)], { encoding: 'utf8' });
}

function launchdTarget(): string {
  return `${launchdDomain()}/${LABEL}`;
}

function isLoaded(): boolean {
  return runCommand(LAUNCHCTL, ['print', launchdTarget()]).status === 0;
}

function bootoutLoadedJob(): void {
  if (!isLoaded()) return;
  const result = runCommand(LAUNCHCTL, ['bootout', launchdTarget()]);
  if (result.status !== 0) {
    throw new InstallerError(`launchctl bootout ${LABEL} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!isLoaded()) return;
    sleepSeconds(0.1);
  }
  throw new InstallerError(`${LABEL} did not stop after launchctl bootout`);
}

function bootstrapJob(options: InstallerOptions): void {
  const enable = runCommand(LAUNCHCTL, ['enable', launchdTarget()]);
  if (enable.status !== 0) {
    throw new InstallerError(`launchctl enable ${LABEL} failed: ${enable.stderr.trim() || `exit ${enable.status}`}`);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = runCommand(LAUNCHCTL, ['bootstrap', launchdDomain(), options.plistPath]);
    if (result.status === 0 || isLoaded()) return;
    sleepSeconds(0.25);
  }
  throw new InstallerError(`launchctl bootstrap ${LABEL} failed (plist: ${options.plistPath})`);
}

/** Write the plist atomically through plutil, like the agent-trace installer. */
function writePlistAtomically(options: InstallerOptions, value: ServiceJob): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agent-journal-plist-'));
  try {
    const json = path.join(directory, 'service.json');
    writeFileSync(json, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const pending = `${options.plistPath}.pending`;
    const convert = runCommand(PLUTIL, ['-convert', 'xml1', '-o', pending, json]);
    if (convert.status !== 0) {
      throw new InstallerError(`plutil -convert failed for ${LABEL}: ${convert.stderr.trim() || `exit ${convert.status}`}`);
    }
    chmodSync(pending, 0o600);
    const lint = runCommand(PLUTIL, ['-lint', pending]);
    if (lint.status !== 0) {
      throw new InstallerError(`plutil -lint failed for ${LABEL}: ${lint.stderr.trim() || `exit ${lint.status}`}`);
    }
    const move = runCommand('/bin/mv', ['-f', pending, options.plistPath]);
    if (move.status !== 0) {
      throw new InstallerError(`Installing ${options.plistPath} failed: ${move.stderr.trim() || `exit ${move.status}`}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function install(options: InstallerOptions, config: JournalConfig): Promise<void> {
  ensureStateDirectory(options);
  const token = readSecretFile(options.tokenFile, 'Trace token');
  const notes: string[] = [];
  if (ensureModelKeyFile(options, config)) {
    notes.push('created key file from environment (value not printed)');
  }
  const cli = path.join(options.repoRoot, 'dist/cli.js');
  if (!existsSync(cli)) {
    throw new InstallerError(`Missing build: ${cli}\nRun "npm run build" in ${options.repoRoot} first.`);
  }
  if (options.skipTokenCheck) {
    notes.push('Trace token check skipped (--skip-token-check)');
  } else {
    await probeTrace(config, token);
  }

  touchLog(options.logPath);
  touchLog(options.errorLogPath);
  writeFileSync(options.wrapperPath, buildWrapper(options, config), { mode: 0o600 });
  chmodSync(options.wrapperPath, 0o600);
  mkdirSync(options.plistDir, { recursive: true });

  bootoutLoadedJob();
  writePlistAtomically(options, buildJob(options));
  bootstrapJob(options);

  process.stdout.write([
    `Installed ${LABEL} (daily 06:30 local time, RunAtLoad off)`,
    `Plist:    ${options.plistPath}`,
    `Wrapper:  ${options.wrapperPath}`,
    `Config:   ${options.configPath}`,
    `Logs:     ${options.logPath} (stdout), ${options.errorLogPath} (stderr)`,
    `Retries:  ${options.retries} (transient only; FOLLOW_LOCKED is treated as benign)`,
    options.knowledge
      ? `Knowledge: sync --source ${options.knowledge.source} via ${options.knowledge.cli}`
      : 'Knowledge: not included (no --knowledge-source)',
    ...notes,
    `Run now:  launchctl kickstart -k ${launchdTarget()}`,
    '',
  ].join('\n'));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  // Check consent before loading config, touching the filesystem, probing the
  // network or invoking launchctl. Explicit --dry-run always wins over --apply.
  if (!options.dryRun && !options.apply) {
    throw new InstallerError('Refusing to change launchd without --apply; use --dry-run to review the plan.');
  }
  if (!options.dryRun && process.platform !== 'darwin') {
    throw new InstallerError('This installer requires macOS (launchd).');
  }
  if (!options.dryRun) preflightManagedPaths(options);
  if (options.uninstall) {
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(buildUninstallPlan(options), null, 2)}\n`);
      return;
    }
    bootoutLoadedJob();
    if (existsSync(options.plistPath)) rmSync(options.plistPath);
    process.stdout.write(`Removed ${LABEL} (${options.plistPath}); state directory and logs were kept.\n`);
    return;
  }

  const config = loadJournalConfig(options.configPath);
  validateKnowledge(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(buildInstallPlan(options, config), null, 2)}\n`);
    return;
  }
  await install(options, config);
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    if (error instanceof InstallerError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
