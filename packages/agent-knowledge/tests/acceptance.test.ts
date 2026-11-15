import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { evaluateTrace, runProcess } from '../scripts/verify-codex.mjs';

const run = promisify(execFile);
const skillProbe = 'KR-SKILL-abcdef123456';
const expected = { path: 'knowledge.md', hash: 'a'.repeat(64), value: 'KR-123456', skillProbe, requireSkill: true };
const record = { id: 'record-1', content: 'KR-123456', source_refs: [{ path: expected.path, content_hash: expected.hash, source_version_id: 'source-version-1', start_line: 1, end_line: 2 }] };
const event = (item: object) => JSON.stringify({ type: 'item.completed', item });
const skill = event({ type: 'agent_message', text: skillProbe });
const search = event({ type: 'mcp_tool_call', status: 'completed', server: 'knowrelay', tool: 'search_context', arguments: { query: '代号' }, result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ record }] }) }] } });
const read = event({ type: 'mcp_tool_call', status: 'completed', server: 'knowrelay', tool: 'read_record', arguments: { record_id: record.id }, result: { content: [{ type: 'text', text: JSON.stringify({ record }) }] } });
const answer = event({ type: 'agent_message', text: `代号是 KR-123456，来源 knowledge.md:1-2，source_version_id source-version-1，content_hash ${expected.hash}` });
const done = JSON.stringify({ type: 'turn.completed' });
const transcript = (...entries: string[]) => entries.join('\n');

test('acceptance requires real, ordered tool results, complete citation and observable skill use', () => {
  assert.equal(evaluateTrace(transcript(skill, search, read, answer, done), expected).status, 'passed');
  for (const incomplete of [
    transcript(search, read, answer, done), // A claimed skill does not prove activation.
    transcript(skill, read, search, answer, done),
    transcript(skill, search, answer, done),
    transcript(skill, search, read, answer),
    transcript(skill, search, read, answer.replace(expected.hash, 'b'.repeat(64)), done),
    transcript(skill, search, read.replace('record-1', 'other-record'), answer, done),
    transcript(skill, search, read, answer, done, 'not json'),
  ]) assert.equal(evaluateTrace(incomplete, expected).status, 'inconclusive');
});

test('a random skill body probe proves loading only when emitted as an agent message before search starts', () => {
  const probeMessage = event({ type: 'agent_message', text: skillProbe });
  const expectedWithProbe = { ...expected, skillProbe };
  const passed = evaluateTrace(transcript(probeMessage, search, read, answer, done), expectedWithProbe);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.evidence.skillEvidence, 'skill_body_probe');
  const claim = event({ type: 'agent_message', text: '我会使用 knowrelay 技能。' });
  assert.equal(evaluateTrace(transcript(claim, search, read, answer, done), expectedWithProbe).status, 'inconclusive');
  assert.equal(evaluateTrace(transcript(search, probeMessage, read, answer, done), expectedWithProbe).status, 'inconclusive');
  const started = JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', status: 'in_progress', server: 'knowrelay', tool: 'search_context' } });
  assert.equal(evaluateTrace(transcript(started, probeMessage, search, read, answer, done), expectedWithProbe).status, 'inconclusive');
  const otherTool = event({ type: 'mcp_tool_call', status: 'completed', server: 'other', tool: 'test', result: { content: [{ type: 'text', text: skillProbe }] } });
  assert.equal(evaluateTrace(transcript(otherTool, search, read, answer, done), expectedWithProbe).status, 'inconclusive');
  const emptyRead = event({ type: 'command_execution', status: 'completed', exit_code: 0, command: 'head -n 0 .agents/skills/agent-knowledge/SKILL.md', aggregated_output: '' });
  assert.equal(evaluateTrace(transcript(emptyRead, search, read, answer, done), expectedWithProbe).status, 'inconclusive');
});

test('deleted-source acceptance requires a real empty result and a non-fabricated answer', () => {
  const noResults = event({ type: 'mcp_tool_call', status: 'completed', server: 'knowrelay', tool: 'search_context', arguments: { query: '交接 代号' }, result: { content: [{ type: 'text', text: '{"results":[]}' }] } });
  const noAnswer = event({ type: 'agent_message', text: '没有找到可引用的来源，无法确认代号。' });
  assert.equal(evaluateTrace(transcript(noResults, noAnswer, done), { ...expected, absent: true, requireSkill: false }).status, 'passed');
  assert.equal(evaluateTrace(transcript(noAnswer, done), { ...expected, absent: true, requireSkill: false }).status, 'inconclusive');
  assert.equal(evaluateTrace(transcript(noResults, answer, done), { ...expected, absent: true, requireSkill: false }).status, 'inconclusive');
  const invented = event({ type: 'agent_message', text: '没有找到来源，不过代号是 KR-111111111111111111111111。' });
  assert.equal(evaluateTrace(transcript(noResults, invented, done), { ...expected, absent: true, requireSkill: false }).status, 'inconclusive');
  const unrelated = noResults.replace('交接 代号', '无关检索词');
  const wrongQuery = evaluateTrace(transcript(unrelated, noAnswer, done), { ...expected, absent: true, requireSkill: false });
  assert.equal(wrongQuery.status, 'inconclusive');
  assert.equal(wrongQuery.evidence.relevantEmptySearch, false);
  const staleSearch = evaluateTrace(transcript(search, noResults, noAnswer, done), { ...expected, absent: true, requireSkill: false });
  assert.equal(staleSearch.status, 'inconclusive');
  assert.equal(staleSearch.evidence.staleSourceObserved, true);
  const staleRead = evaluateTrace(transcript(read, noResults, noAnswer, done), { ...expected, absent: true, requireSkill: false });
  assert.equal(staleRead.status, 'inconclusive');
  assert.equal(staleRead.evidence.staleSourceObserved, true);
});

test('unavailable acceptance requires a loaded skill, explicit uncertainty and no tool calls or invented source', () => {
  const unavailable = { ...expected, unavailable: true };
  const noTool = event({ type: 'agent_message', text: '{"status":"unavailable","message":"KnowRelay 未连接，无法核实交接代号。"}' });
  assert.equal(evaluateTrace(transcript(skill, noTool, done), unavailable).status, 'passed');
  assert.equal(evaluateTrace(transcript(noTool, done), unavailable).status, 'inconclusive');
  assert.equal(evaluateTrace(transcript(skill, search, noTool, done), unavailable).status, 'inconclusive');
  const attempt = JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'knowrelay', tool: 'read_record', status: 'in_progress' } });
  assert.equal(evaluateTrace(transcript(skill, attempt, noTool, done), unavailable).status, 'inconclusive');
  const fabricated = event({ type: 'agent_message', text: 'KnowRelay 未连接，无法核实；来源是 knowledge.md。' });
  assert.equal(evaluateTrace(transcript(skill, fabricated, done), unavailable).status, 'inconclusive');
  const partial = event({ type: 'agent_message', text: 'AgentKnowledge 工具未连接。' });
  assert.equal(evaluateTrace(transcript(skill, partial, done), unavailable).status, 'inconclusive');
  const otherFabrication = event({ type: 'agent_message', text: 'KnowRelay 未连接，无法核实。但交接代号是 ALPHA，来源：handover.md:1-2，source_version_id: fake-version。' });
  assert.equal(evaluateTrace(transcript(skill, otherFabrication, done), unavailable).status, 'inconclusive');
  assert.equal(evaluateTrace(transcript(skill, otherFabrication, noTool, done), unavailable).status, 'inconclusive');
  const extraField = event({ type: 'agent_message', text: '{"status":"unavailable","message":"KnowRelay 未连接，无法核实交接代号。","source":"fake.md"}' });
  assert.equal(evaluateTrace(transcript(skill, extraField, done), unavailable).status, 'inconclusive');
});

test('timed out processes and their children are stopped', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-runner-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'still-running');
  const childCode = `console.log('child-ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 3500); setInterval(() => {}, 1000)`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`;
  // Allow both Node processes to boot during the parallel full-suite run.
  const result = await runProcess(process.execPath, ['-e', parentCode], { cwd: dir, timeoutMs: 2000 });
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /child-ready/);
  await new Promise((resolve) => setTimeout(resolve, 3700));
  await assert.rejects(access(marker));
});

test('excess output terminates a process that ignores SIGTERM without waiting for the full timeout', async () => {
  const childCode = `process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)`;
  const result = await runProcess(process.execPath, ['-e', childCode], { cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test('prepared and unverified mock runs cannot be reported as passed or expose the synthetic answer in the prompt', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-runner-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.resolve('scripts/verify-codex.mjs');
  const preparedDir = path.join(dir, 'prepared');
  const prepare = await run(process.execPath, [script, '--prepare-only', '--output-dir', preparedDir]);
  assert.equal(JSON.parse(prepare.stdout).status, 'prepared');
  await access(path.join(preparedDir, 'workspace/.agents/skills/agent-knowledge/SKILL.md'));
  const mockCodex = path.join(dir, 'mock-codex');
  await writeFile(mockCodex, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.argv.at(-1)}})); console.log(JSON.stringify({type:'turn.completed'}));`, { mode: 0o700 });
  const resultDir = path.join(dir, 'run');
  await assert.rejects(run(process.execPath, [script, '--codex', mockCodex, '--case', 'explicit', '--output-dir', resultDir]));
  const summary = JSON.parse(await readFile(path.join(resultDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'inconclusive');
  assert.equal(summary.cases[0].evidence.skillObserved, false);
  const source = await readFile(path.join(resultDir, 'sources/knowledge.md'), 'utf8');
  const output = await readFile(path.join(resultDir, 'explicit.stdout.jsonl'), 'utf8');
  assert.doesNotMatch(output, new RegExp(source.match(/KR-[a-f0-9]+/)![0]));
  const isolatedSkill = await readFile(path.join(resultDir, 'workspace/.agents/skills/agent-knowledge/SKILL.md'), 'utf8');
  const probe = isolatedSkill.match(/KR-SKILL-[a-f0-9]+/)![0];
  assert.doesNotMatch(source, new RegExp(probe));
  assert.doesNotMatch(output, new RegExp(probe));
});

test('a complete mock trace cannot pass without an observed successful Codex version', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-runner-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mockCodex = path.join(dir, 'mock-codex.mjs');
  const fake = `#!${process.execPath}
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const argv=process.argv.slice(2);
if (argv.includes('--version')) { console.log('unknown'); process.exit(0); }
const workspace=argv[argv.indexOf('--cd')+1];
const skill=readFileSync(path.join(workspace,'.agents/skills/agent-knowledge/SKILL.md'),'utf8');
const probe=skill.match(/KR-SKILL-[a-f0-9]+/)[0];
const arg=argv.find(x=>x.startsWith('mcp_servers.agent-knowledge.args='));
const args=JSON.parse(arg.slice(arg.indexOf('=')+1));
const config=JSON.parse(readFileSync(args[args.indexOf('--config')+1],'utf8'));
const body=readFileSync(path.join(config.sources[0].root,'knowledge.md'),'utf8');
const value=body.match(/KR-[a-f0-9]{24}/)[0];
const hash=createHash('sha256').update(body).digest('hex');
const record={id:'test',content:body,source_refs:[{path:'knowledge.md',content_hash:hash,source_version_id:'version',start_line:1,end_line:2}]};
const event=item=>console.log(JSON.stringify({type:'item.completed',item}));
event({type:'agent_message',text:probe});
event({type:'mcp_tool_call',status:'completed',server:'knowrelay',tool:'search_context',arguments:{query:'交接代号'},result:{structured_content:{results:[{record}]}}});
event({type:'mcp_tool_call',status:'completed',server:'knowrelay',tool:'read_record',arguments:{record_id:'test'},result:{structured_content:{record}}});
event({type:'agent_message',text:value+' knowledge.md:1-2 '+hash+' version'});
console.log(JSON.stringify({type:'turn.completed'}));
`;
  await writeFile(mockCodex, fake, { mode: 0o700 });
  const output = path.join(dir, 'run');
  await assert.rejects(run(process.execPath, [path.resolve('scripts/verify-codex.mjs'), '--codex', mockCodex, '--case', 'explicit', '--output-dir', output]));
  const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.cases[0].status, 'passed');
  assert.equal(summary.version_verified, false);
  assert.equal(summary.status, 'inconclusive');
});

test('all mode records later independent cases after an inconclusive result', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-runner-all-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mockCodex = path.join(dir, 'mock-codex');
  await writeFile(mockCodex, `#!${process.execPath}\nif(process.argv.includes('--version')) {console.log('codex-cli 0.test'); process.exit(0)}\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'insufficient evidence'}})); console.log(JSON.stringify({type:'turn.completed'}));`, { mode: 0o700 });
  const output = path.join(dir, 'run');
  await assert.rejects(run(process.execPath, [path.resolve('scripts/verify-codex.mjs'), '--codex', mockCodex, '--case', 'all', '--output-dir', output]));
  const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'inconclusive');
  assert.deepEqual(summary.cases.map((item: {label: string}) => item.label), ['explicit', 'automatic', 'lifecycle-baseline', 'lifecycle-updated', 'lifecycle-deleted']);
  assert.ok(summary.cases.every((item: {status: string}) => item.status === 'inconclusive'));
});

test('interrupting the runner stops its child group and writes a blocked summary', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'knowrelay-runner-signal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ready = path.join(dir, 'ready');
  const marker = path.join(dir, 'should-not-survive');
  const mockCodex = path.join(dir, 'mock-codex');
  const grandchild = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1400);setInterval(()=>{},1000)`;
  const fake = `#!${process.execPath}
if(process.argv.includes('--version')) {console.log('codex-cli 0.test');process.exit(0)}
process.on('SIGTERM',()=>{});
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});
setInterval(()=>{},1000);
`;
  await writeFile(mockCodex, fake, { mode: 0o700 });
  const output = path.join(dir, 'run');
  const runner = spawn(process.execPath, [path.resolve('scripts/verify-codex.mjs'), '--codex', mockCodex, '--case', 'explicit', '--timeout-ms', '15000', '--output-dir', output], { stdio: 'ignore' });
  const closed = new Promise<number | null>((resolve, reject) => { runner.once('error', reject); runner.once('close', resolve); });
  let started = false;
  for (let i = 0; i < 400; i++) {
    try { await access(ready); started = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
  }
  if (!started) { runner.kill('SIGTERM'); await closed; assert.fail('mock child did not start'); }
  runner.kill('SIGTERM');
  assert.equal(await closed, 1);
  const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.interrupted, 'SIGTERM');
  assert.equal(summary.cases.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(access(marker));
});
