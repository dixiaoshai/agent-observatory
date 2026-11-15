#!/usr/bin/env node
/** Reproducible, isolated Codex integration acceptance using synthetic knowledge. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxOutputBytes = 1024 * 1024;
const referencePath = 'knowledge.md';
const cases = ['explicit', 'automatic', 'lifecycle'];
const syntheticPrompt = '使用当前项目知识回答：验收项目的交接代号是什么？请提供来源文件路径、行号、source_version_id 和完整 content_hash。只依据可核验的知识工具结果回答，不要通过 shell 或其他工具读取资料。';
const explicitPrompt = `$agent-knowledge ${syntheticPrompt} 请先调用 search_context，再调用 read_record 核对来源。`;
const absentPrompt = '请核查验收项目的交接代号当前是否有可引用的来源。请用“交接代号”作为关键词调用知识搜索；如果找不到来源，明确说明无法确认，不要猜测或引用已删除内容。';
const unavailableResponse = { status: 'unavailable', message: 'Agent Knowledge 未连接，无法核实交接代号。' };
const unavailableMessages = new Set([unavailableResponse.message, 'KnowRelay 未连接，无法核实交接代号。']);
const unavailablePrompt = `$agent-knowledge 核实当前项目的交接代号。只依靠已连接的知识工具，不通过 shell 或其他工具读取资料。若知识工具未连接，除了技能要求的独立探针消息外，只输出以下 JSON，不添加答案、来源或其他说明：${JSON.stringify(unavailableResponse)}`;

function hash(content) { return createHash('sha256').update(content).digest('hex'); }
function credentialRedact(text) {
  return String(text)
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1[REDACTED]');
}
function jsonObject(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function contentJson(result) {
  const value = jsonObject(result);
  if (!value || typeof value !== 'object') return null;
  const structured = value.structuredContent ?? value.structured_content;
  if (structured && typeof structured === 'object') return structured;
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      const parsed = jsonObject(block?.text);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  }
  return value;
}
/** A pass requires observable, ordered successful tool calls and a matching final answer. */
export function evaluateTrace(stdout, expected) {
  let malformed = false;
  const events = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch { malformed = true; }
  }
  const items = events.filter((event) => event?.type === 'item.completed').map((event) => event.item);
  const answer = items.filter((item) => item?.type === 'agent_message' && typeof item.text === 'string').map((item) => item.text).at(-1) ?? '';
  const knowrelayCalls = events.some((event) => {
    const item = event?.item;
    return item?.type === 'mcp_tool_call' && (['knowrelay', 'agent-knowledge'].includes(item.server) || (String(item.tool ?? item.name ?? '').startsWith('mcp__knowrelay__') || String(item.tool ?? item.name ?? '').startsWith('mcp__agent-knowledge__')));
  });
  let skillEvidence = null;
  // A random probe can only be learned from the isolated skill body. Require
  // the output before search starts; a later answer or tool result proves less.
  for (const event of events) {
    const item = event?.item;
    if (item?.type === 'mcp_tool_call' && (['knowrelay', 'agent-knowledge'].includes(item.server) || (String(item.tool ?? item.name ?? '').startsWith('mcp__knowrelay__') || String(item.tool ?? item.name ?? '').startsWith('mcp__agent-knowledge__'))) &&
        ['search_context', 'mcp__knowrelay__search_context', 'mcp__agent-knowledge__search_context'].includes(item.tool ?? item.name)) break;
    if (event?.type !== 'item.completed') continue;
    if (expected.skillProbe && item?.type === 'agent_message' && typeof item.text === 'string' && item.text.includes(expected.skillProbe)) {
      skillEvidence = 'skill_body_probe'; break;
    }
  }
  const skillObserved = skillEvidence !== null;
  let searchRecord = null;
  let matchedRecord = null;
  let emptySearch = false;
  let relevantEmptySearch = false;
  let staleSourceObserved = false;
  for (const item of items) {
    if (!item || item.type !== 'mcp_tool_call' || item.status !== 'completed' || item.error || item.result?.isError || item.result?.is_error) continue;
    const name = String(item.tool ?? item.name ?? '');
    if (!['knowrelay', 'agent-knowledge'].includes(item.server) && !name.startsWith('mcp__knowrelay__') && !name.startsWith('mcp__agent-knowledge__')) continue;
    const response = contentJson(item.result);
    if (!response) continue;
    const responseText = JSON.stringify(response);
    if (expected.absent && (responseText.includes(expected.path) || responseText.includes(expected.value) || responseText.includes(expected.hash))) {
      staleSourceObserved = true;
    }
    if (name === 'search_context' || name === 'mcp__knowrelay__search_context' || name === 'mcp__agent-knowledge__search_context') {
      if (Array.isArray(response.results) && response.results.length === 0) {
        emptySearch = true;
        const args = jsonObject(item.arguments);
        if (typeof args?.query === 'string' && args.query.replace(/\s+/g, '').includes('交接代号')) relevantEmptySearch = true;
      }
      if (Array.isArray(response.results)) searchRecord = response.results.map((hit) => hit?.record).find((record) =>
        record?.source_refs?.[0]?.path === expected.path && record?.source_refs?.[0]?.content_hash === expected.hash &&
        record?.content?.includes(expected.value)) ?? searchRecord;
    } else if (name === 'read_record' || name === 'mcp__knowrelay__read_record' || name === 'mcp__agent-knowledge__read_record') {
      const args = jsonObject(item.arguments);
      const record = response.record;
      if (searchRecord && record?.id === searchRecord.id && args?.record_id === record.id &&
          record?.source_refs?.[0]?.content_hash === expected.hash && record?.content?.includes(expected.value)) matchedRecord = record;
    }
  }
  const ref = matchedRecord?.source_refs?.[0];
  const validRef = typeof ref?.source_version_id === 'string' && ref.source_version_id.length > 0 &&
    ref.start_line === 1 && ref.end_line === 2 && ref.path === expected.path;
  const answerHasLines = /(?:第\s*1\s*[-–—~至]\s*2\s*行|(?:\b1\s*[-–—~:]\s*2\b)|(?:\bL1\s*[-–—~]\s*L?2\b))/i.test(answer);
  const answerMatches = !!ref && answer.includes(expected.value) && answer.includes(expected.path) &&
    answer.includes(expected.hash) && answer.includes(ref.source_version_id) && answerHasLines;
  const confirmedAbsent = relevantEmptySearch && !staleSourceObserved && !answer.includes(expected.value) && !answer.includes(expected.hash) &&
    !/\bKR-[a-f0-9]{24}\b/i.test(answer) && !/\b[a-f0-9]{64}\b/i.test(answer) &&
    /(?:未找到|没有|不存在|无法确认|不能确认|无相关|无法找到|没有找到|not found|no (?:matching|relevant|source))/i.test(answer);
  const toolUnavailableAcknowledged = /(?:未连接|未提供|不可用|无法(?:调用|使用)|没有(?:可用|连接)|缺少.*工具|工具不存在|未发现.*工具|not (?:available|connected)|unavailable)/i.test(answer);
  const unverifiedAcknowledged = /(?:无法(?:核实|确认|查询|检索|确定|读取)|不能(?:核实|确认|确定)|不可验证|无法从.*(?:核实|确认)|cannot (?:verify|confirm|search)|unable to (?:verify|confirm|search))/i.test(answer);
  // Free-text keyword exclusions cannot prove absence of invented facts. This
  // isolated case requests one exact structured refusal and rejects all other
  // non-probe assistant messages, including fabrications before a later refusal.
  const nonProbeMessages = items.filter((item) => item?.type === 'agent_message' && typeof item.text === 'string')
    .map((item) => item.text.trim()).filter((text) => text !== expected.skillProbe);
  const refusal = nonProbeMessages.length === 1 ? jsonObject(nonProbeMessages[0].replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')) : null;
  const unavailableAnswerNoFabrication = !!refusal && typeof refusal === 'object' &&
    Object.keys(refusal).length === 2 && refusal.status === unavailableResponse.status && unavailableMessages.has(refusal.message);
  const completed = events.some((event) => event?.type === 'turn.completed') && !events.some((event) => event?.type === 'turn.failed');
  const evidence = { completed, searchObserved: !!searchRecord, readObserved: !!matchedRecord, emptySearch, relevantEmptySearch, staleSourceObserved,
    skillObserved, skillEvidence, validRef, answerMatches, confirmedAbsent, knowrelayCalls,
    toolUnavailableAcknowledged, unverifiedAcknowledged, unavailableAnswerNoFabrication, malformed };
  const contentVerified = expected.unavailable ? !knowrelayCalls && toolUnavailableAcknowledged && unverifiedAcknowledged && unavailableAnswerNoFabrication :
    expected.absent ? confirmedAbsent : !!matchedRecord && validRef && answerMatches;
  const passes = !malformed && completed && contentVerified &&
    (!expected.requireSkill || skillObserved);
  return { status: passes ? 'passed' : 'inconclusive', evidence, answer, record: matchedRecord };
}

/** Bound output and terminate the whole spawned process group on timeout. */
export async function runProcess(command, args, { cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false, truncated = false, spawnError = null, killTimer, interrupted = null;
    const stop = (signal) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    const terminate = () => {
      stop('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => stop('SIGKILL'), 500);
    };
    const onInterrupt = (signal) => { interrupted ??= signal; terminate(); };
    const onSigint = () => onInterrupt('SIGINT');
    const onSigterm = () => onInterrupt('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const append = (current, data) => {
      const remaining = maxOutputBytes - current.length;
      if (data.length > remaining && !truncated) { truncated = true; terminate(); }
      if (remaining <= 0) return current;
      return Buffer.concat([current, data.subarray(0, Math.max(remaining, 0))]);
    };
    child.stdout.on('data', (data) => { stdout = append(stdout, data); });
    child.stderr.on('data', (data) => { stderr = append(stderr, data); });
    child.on('error', (error) => { spawnError = error.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); stop('SIGKILL'); }
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve({ exitCode, signal, timedOut, truncated, interrupted, spawnError, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

async function executable(filename) { try { await access(filename, constants.X_OK); return true; } catch { return false; } }
async function findCodex(explicit) {
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('--codex must be an absolute path');
    if (!await executable(explicit)) throw new Error('Specified Codex executable is not executable');
    return explicit;
  }
  // Prefer the bundled binary: a broken PATH shim should not mask a usable installation.
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  if (await executable(bundled)) return bundled;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const filename = path.resolve(directory, 'codex');
    if (await executable(filename)) return filename;
  }
  throw new Error('Codex executable not found; specify --codex with an absolute path');
}
async function writePrivate(filename, data) { await writeFile(filename, data, { mode: 0o600 }); }
async function syncSource(configPath) {
  const result = await runProcess(process.execPath, [path.join(projectRoot, 'dist/interfaces/cli.js'), 'sync', '--source', 'demo', '--config', configPath, '--request-key', randomUUID()], { cwd: projectRoot, timeoutMs: 30000 });
  if (result.exitCode !== 0 || result.timedOut || result.truncated || result.interrupted || result.spawnError) throw new Error(`Synthetic sync failed or was interrupted: ${credentialRedact(result.stderr).slice(0, 1000)}`);
}
function sourceText(value) { return `# 合成验收资料\n验收项目的交接代号是 ${value}。\n`; }

export async function prepareRun(outputDir, shouldStop = () => false) {
  const runDir = path.resolve(outputDir);
  await mkdir(path.dirname(runDir), { recursive: true, mode: 0o700 });
  await mkdir(runDir, { mode: 0o700 }); // Never reuse or overwrite a prior run.
  try {
  const workspace = path.join(runDir, 'workspace');
  const sourceDir = path.join(runDir, 'sources');
  const skillDir = path.join(workspace, '.agents/skills/agent-knowledge');
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  await mkdir(sourceDir, { mode: 0o700 });
  const skillProbe = `KR-SKILL-${randomBytes(12).toString('hex')}`;
  const baseSkill = await readFile(path.join(projectRoot, 'skills/agent-knowledge/SKILL.md'), 'utf8');
  await writePrivate(path.join(skillDir, 'SKILL.md'), `${baseSkill}\n\n## 合成验收探针\n\n使用本 skill 时，在开始检索前，先发送一条只包含以下标记的独立消息：\n\n${skillProbe}\n\n此标记仅用于证明本次读取了技能正文。\n`);
  const value = `KR-${randomBytes(12).toString('hex')}`;
  const content = sourceText(value);
  const sourceFile = path.join(sourceDir, referencePath);
  await writePrivate(sourceFile, content);
  const configPath = path.join(runDir, 'config.json');
  await writePrivate(configPath, JSON.stringify({ schema_version: 1, database: path.join(runDir, 'knowledge.sqlite'),
    allowed_project_ids: ['demo'], sources: [{ id: 'demo', root: sourceDir, project_id: 'demo', include_extensions: ['.md'] }] }, null, 2));
  if (shouldStop()) throw new Error('Acceptance interrupted during preparation');
  await syncSource(configPath);
  return { runDir, workspace, configPath, sourceFile, value, skillProbe, hash: hash(content) };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.acceptanceRunDir = runDir;
    throw failure;
  }
}
function codexArgs(context, prompt, model, connectMcp = true) {
  const command = `mcp_servers.agent-knowledge.command=${JSON.stringify(process.execPath)}`;
  const args = `mcp_servers.agent-knowledge.args=${JSON.stringify([path.join(projectRoot, 'dist/interfaces/cli.js'), 'serve', '--config', context.configPath])}`;
  return ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', context.workspace,
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'unbounded_connection_retries',
    ...(connectMcp ? ['--config', command, '--config', args] : []), ...(model ? ['--model', model] : []), '--json', prompt];
}
async function executeCase(context, codex, label, prompt, expected, timeoutMs, model, connectMcp = true) {
  const env = { ...process.env };
  if (!env.HTTP_PROXY && env.HTTPS_PROXY) env.HTTP_PROXY = env.HTTPS_PROXY;
  if (!env.http_proxy && env.https_proxy) env.http_proxy = env.https_proxy;
  const result = await runProcess(codex, codexArgs(context, prompt, model, connectMcp), { cwd: context.workspace, timeoutMs, env });
  const evaluation = evaluateTrace(result.stdout, { ...expected, path: referencePath });
  const status = result.exitCode === 0 && !result.timedOut && !result.truncated && !result.interrupted && !result.spawnError ? evaluation.status : 'blocked';
  await writePrivate(path.join(context.runDir, `${label}.stdout.jsonl`), credentialRedact(result.stdout));
  await writePrivate(path.join(context.runDir, `${label}.stderr.log`), credentialRedact(result.stderr));
  await writePrivate(path.join(context.runDir, `${label}.answer.txt`), credentialRedact(evaluation.answer));
  return { label, status, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, truncated: result.truncated,
    interrupted: result.interrupted, spawnError: result.spawnError ? credentialRedact(result.spawnError) : null, evidence: evaluation.evidence,
    sourceVersion: evaluation.record?.source_refs?.[0]?.source_version_id ?? null };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    codex: { type: 'string' }, model: { type: 'string' }, 'timeout-ms': { type: 'string', default: '120000' },
    'output-dir': { type: 'string' }, case: { type: 'string', default: 'all' }, 'prepare-only': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write('Usage: node scripts/verify-codex.mjs [--codex ABS] [--model MODEL] [--case explicit|automatic|lifecycle|unavailable|all] [--timeout-ms MS] [--output-dir PATH] [--prepare-only]\n'); return 0; }
  if (![...cases, 'unavailable', 'all'].includes(values.case)) throw new Error('Invalid --case');
  if (!/^\d+$/.test(values['timeout-ms'])) throw new Error('--timeout-ms must be an integer');
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error('--timeout-ms must be between 100 and 600000');
  const runDir = path.resolve(values['output-dir'] ?? path.join(projectRoot, '.knowrelay/acceptance', `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`));
  const summary = { schema_version: 1, status: values['prepare-only'] ? 'prepared' : 'inconclusive', requested: values.case,
    started_at: new Date().toISOString(), finished_at: null, codex_version: null, version_verified: false, model: values.model ?? null,
    interrupted: null, run_dir: runDir, cases: [], note: 'Synthetic data only. Inconclusive evidence is never considered a pass.' };
  let created = false;
  const onSigint = () => { summary.interrupted ??= 'SIGINT'; };
  const onSigterm = () => { summary.interrupted ??= 'SIGTERM'; };
  const assertRunning = () => { if (summary.interrupted) throw new Error(`Acceptance interrupted by ${summary.interrupted}`); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const context = await prepareRun(runDir, () => !!summary.interrupted);
    created = true;
    assertRunning();
    if (!values['prepare-only']) {
    const codex = await findCodex(values.codex);
    assertRunning();
    const version = await runProcess(codex, ['--version'], { cwd: context.workspace, timeoutMs: 10000 });
    assertRunning();
    summary.codex_version = (version.exitCode === 0 && !version.timedOut && !version.truncated && !version.interrupted && !version.spawnError) ?
      (version.stdout.match(/\bcodex-cli\s+[^\s]+/) ?? [])[0] ?? null : null;
    summary.version_verified = summary.codex_version !== null;
    const selected = values.case === 'all' ? cases : [values.case];
    for (const name of selected) {
      assertRunning();
      let current = { value: context.value, hash: context.hash };
      if (name === 'unavailable') {
        const outcome = await executeCase(context, codex, name, unavailablePrompt,
          { ...current, skillProbe: context.skillProbe, requireSkill: true, unavailable: true }, timeoutMs, values.model, false);
        summary.cases.push(outcome);
        assertRunning();
        if (outcome.status === 'blocked') break;
      } else if (name === 'explicit' || name === 'automatic') {
        const outcome = await executeCase(context, codex, name, name === 'explicit' ? explicitPrompt : syntheticPrompt,
          { ...current, skillProbe: context.skillProbe, requireSkill: true }, timeoutMs, values.model);
        summary.cases.push(outcome);
        assertRunning();
        if (outcome.status === 'blocked') break;
      } else {
        const baseline = await executeCase(context, codex, 'lifecycle-baseline', explicitPrompt, { ...current, skillProbe: context.skillProbe, requireSkill: true }, timeoutMs, values.model);
        summary.cases.push(baseline);
        assertRunning();
        if (baseline.status === 'blocked') break;
        const updatedValue = `KR-${randomBytes(12).toString('hex')}`;
        const content = sourceText(updatedValue);
        await writePrivate(context.sourceFile, content);
        assertRunning();
        await syncSource(context.configPath);
        assertRunning();
        const updated = await executeCase(context, codex, 'lifecycle-updated', explicitPrompt, { value: updatedValue, hash: hash(content), skillProbe: context.skillProbe, requireSkill: true }, timeoutMs, values.model);
        if (updated.status === 'passed' && (!baseline.sourceVersion || updated.sourceVersion === baseline.sourceVersion)) updated.status = 'inconclusive';
        summary.cases.push(updated);
        assertRunning();
        if (updated.status === 'blocked') break;
        const { unlink } = await import('node:fs/promises');
        await unlink(context.sourceFile);
        assertRunning();
        await syncSource(context.configPath);
        assertRunning();
        const deleted = await executeCase(context, codex, 'lifecycle-deleted', absentPrompt, { value: updatedValue, hash: hash(content), absent: true }, timeoutMs, values.model);
        summary.cases.push(deleted);
        assertRunning();
        if (deleted.status !== 'passed') break;
      }
    }
    const expectedCount = values.case === 'all' ? 5 : values.case === 'lifecycle' ? 3 : 1;
    summary.status = summary.version_verified && summary.cases.length === expectedCount && summary.cases.every((outcome) => outcome.status === 'passed') ? 'passed' :
      summary.cases.some((outcome) => outcome.status === 'blocked') ? 'blocked' : 'inconclusive';
    }
  } catch (error) {
    if (error?.acceptanceRunDir === runDir) created = true;
    summary.status = 'blocked';
    summary.error = credentialRedact(error instanceof Error ? error.message : String(error));
  } finally {
    if (summary.interrupted) summary.status = 'blocked';
    summary.finished_at = new Date().toISOString();
    try {
      if (created) await writePrivate(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.status === 'passed' || summary.status === 'prepared' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${credentialRedact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
