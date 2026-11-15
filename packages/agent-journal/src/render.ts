import type { DayBundle, SessionProjection } from './projection.ts';
import type { DayReport } from './model.ts';
import { localHhmm } from './day.ts';

export interface RenderOptions {
  model?: string | null;
  promptVersion?: number | null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderSession(lines: string[], session: SessionProjection, timeZone: string): void {
  const label = session.title ?? session.user_messages.find((message) => message.title)?.title ?? '(未命名会话)';
  const start = session.started_at ? localHhmm(session.started_at, timeZone) : '??:??';
  const end = session.ended_at ? localHhmm(session.ended_at, timeZone) : '??:??';
  lines.push(`### ${start}–${end} · ${session.runtime} · ${oneLine(label).slice(0, 120)}`);
  lines.push('');
  lines.push(`- 会话标识：\`${session.session_id}\``);
  lines.push(`- 事件 ${session.counts.events}（unknown ${session.counts.unknown} / reasoning ${session.counts.reasoning}），答复 ${session.counts.answers}，工具 ${session.counts.tools}${session.open_ended ? '，**有未完成轮次**' : ''}`);
  if (session.user_messages.length) {
    lines.push('- 用户请求：');
    for (const message of session.user_messages.slice(0, 8)) {
      const text = oneLine(message.title ?? message.text);
      lines.push(`  - ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`);
    }
  }
  const answers = [...session.final_answers, ...session.fallback_answers];
  if (answers.length) {
    lines.push(`- 最终答复${session.fallback_answers.length ? '（从助手消息回退）' : ''}：`);
    for (const answer of answers.slice(0, 3)) {
      const text = oneLine(answer.text);
      lines.push(`  - ${text.slice(0, 240)}${text.length > 240 ? '…' : ''}`);
    }
  }
  const tools = Object.entries(session.tool_counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name}×${count}`);
  if (tools.length) lines.push(`- 工具：${tools.join('、')}`);
  if (session.touched_paths.length) {
    lines.push(`- 触及路径（${session.touched_paths.length}）：${session.touched_paths.slice(0, 6).join('、')}`);
  }
  if (session.usage.cost_usd) lines.push(`- 记录成本：$${session.usage.cost_usd.toFixed(4)}（${session.usage.cost_sources.join('/') || 'unknown'}）`);
  lines.push('');
}

/** Render the deterministic note. This is deliberately model-free and must
 * keep every claim traceable to the session ids above. */
export function renderDeterministic(bundle: DayBundle, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`date: ${bundle.day}`);
  lines.push(`timezone: ${bundle.timezone}`);
  lines.push('generated: false');
  lines.push(`generator: agent-journal`);
  lines.push(`model: ${options.model ? options.model : 'null'}`);
  lines.push(`prompt_version: ${options.promptVersion === undefined || options.promptVersion === null ? 'null' : options.promptVersion}`);
  lines.push(`projects: [${bundle.projects.join(', ')}]`);
  lines.push(`sessions: ${bundle.totals.sessions}`);
  lines.push(`events: ${bundle.totals.events}`);
  lines.push(`projected_tokens: ${bundle.totals.projected_tokens}`);
  lines.push(`coverage: { backfill_events: ${bundle.coverage.backfill_events}, occurred_at_missing: ${bundle.coverage.occurred_at_missing} }`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${bundle.day} 工作日回顾（确定性骨架）`);
  lines.push('');
  lines.push('> 由 `agent-journal` 从 Trace content 归档确定性生成，未调用模型；内容只是摘要，原始证据以会话标识回查。');
  lines.push('');
  lines.push('## 概览');
  lines.push('');
  lines.push(`- 会话：${bundle.totals.sessions}，事件：${bundle.totals.events}，项目：${bundle.projects.join('、') || '—'}`);
  lines.push(`- 观测覆盖：${bundle.coverage.observed_same_day} 个事件在当天结束前已观测，${bundle.coverage.observed_after_day} 个在之后到达，${bundle.coverage.backfill_events} 个判为历史回补并排除`);
  lines.push(`- 投影体积：约 ${bundle.totals.projected_tokens} tokens（${bundle.totals.projected_chars} 字符）`);
  if (bundle.totals.cost_usd_recorded) lines.push(`- 记录成本：$${bundle.totals.cost_usd_recorded.toFixed(4)}`);
  lines.push('');
  for (const project of bundle.projects) {
    const sessions = bundle.sessions.filter((session) => session.project_id === project);
    if (!sessions.length) continue;
    lines.push(`## ${project}`);
    lines.push('');
    for (const session of sessions) renderSession(lines, session, bundle.timezone);
  }
  if (!bundle.sessions.length) {
    lines.push('## 无内容');
    lines.push('');
    lines.push('这一天没有可投影的会话（可能未采集、全部被回补过滤或已删除）。');
    lines.push('');
  }
  lines.push('---');
  lines.push('说明：日报是模型/工具生成的二手摘要，不是原始事实；引用前请用会话标识回查 Trace 或 Knowledge 中的事件。');
  return `${lines.join('\n')}\n`;
}

export interface ModelReportOptions {
  model: string;
  promptVersion: number;
}

/** Render the model-written daily review. The deterministic detail is not
 * appended here; the note keeps the model summary plus session identifiers so
 * every claim can be checked against the archive. */
export function renderModelReport(bundle: DayBundle, report: DayReport, options: ModelReportOptions): string {
  const bySession = new Map(bundle.sessions.map((session) => [session.session_key, session]));
  const lines: string[] = [];
  lines.push('---');
  lines.push(`date: ${bundle.day}`);
  lines.push(`timezone: ${bundle.timezone}`);
  lines.push('generated: true');
  lines.push('generator: agent-journal');
  lines.push(`model: ${options.model}`);
  lines.push(`prompt_version: ${options.promptVersion}`);
  lines.push(`projects: [${bundle.projects.join(', ')}]`);
  lines.push(`sessions: ${bundle.totals.sessions}`);
  lines.push(`events: ${bundle.totals.events}`);
  lines.push(`projected_tokens: ${bundle.totals.projected_tokens}`);
  lines.push(`dropped_sessions: ${report.dropped_sessions}`);
  lines.push(`coverage: { backfill_events: ${bundle.coverage.backfill_events}, occurred_at_missing: ${bundle.coverage.occurred_at_missing} }`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${bundle.day} 工作日回顾`);
  lines.push('');
  lines.push(`> 由 \`${options.model}\` 基于 Trace content 投影生成（prompt v${options.promptVersion}）。这是二手摘要，不是原始事实；引用前请用会话标识回查事件。`);
  lines.push('');
  lines.push('## 今天做了什么');
  lines.push('');
  if (report.highlights.length) {
    for (const highlight of report.highlights) lines.push(`- ${oneLine(highlight)}`);
  } else {
    lines.push('（模型没有给出明确亮点）');
  }
  lines.push('');
  lines.push('## 按项目');
  lines.push('');
  if (report.projects.length) {
    for (const project of report.projects) {
      const sessions = bundle.sessions.filter((session) => session.project_id === project.project_id);
      lines.push(`- **${project.project_id}**（${sessions.length} 会话）：${oneLine(project.summary)}`);
    }
  } else {
    lines.push('（无）');
  }
  lines.push('');
  lines.push('## 决策与变更');
  lines.push('');
  if (report.decisions.length) for (const decision of report.decisions) lines.push(`- ${oneLine(decision)}`);
  else lines.push('（无明确决策）');
  lines.push('');
  lines.push('## 未完成 / 阻塞');
  lines.push('');
  if (report.blockers.length) for (const blocker of report.blockers) lines.push(`- ${oneLine(blocker)}`);
  else lines.push('（无）');
  lines.push('');
  lines.push('## 明天建议');
  lines.push('');
  if (report.next_steps.length) for (const step of report.next_steps) lines.push(`- ${oneLine(step)}`);
  else lines.push('（无）');
  lines.push('');
  lines.push('## 会话摘要');
  lines.push('');
  const notes = [...report.session_notes].sort((a, b) => {
    const left = bySession.get(a.session_key);
    const right = bySession.get(b.session_key);
    return (left?.started_at ? Date.parse(left.started_at) : 0) - (right?.started_at ? Date.parse(right.started_at) : 0);
  });
  if (!notes.length) {
    lines.push('（无会话摘要）');
    lines.push('');
  }
  for (const note of notes) {
    const session = bySession.get(note.session_key);
    if (!session) continue;
    const label = session.title ?? session.user_messages.find((message) => message.title)?.title ?? '(未命名会话)';
    const start = session.started_at ? localHhmm(session.started_at, bundle.timezone) : '??:??';
    const end = session.ended_at ? localHhmm(session.ended_at, bundle.timezone) : '??:??';
    lines.push(`### ${start}–${end} · ${session.project_id} · ${oneLine(label).slice(0, 120)}`);
    lines.push('');
    lines.push(`- 会话标识：\`${session.session_id}\``);
    lines.push(`- 摘要：${oneLine(note.summary)}`);
    if (note.decisions.length) lines.push(`- 决策：${note.decisions.map(oneLine).join('；')}`);
    if (note.follow_ups.length) lines.push(`- 待续：${note.follow_ups.map(oneLine).join('；')}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('## 覆盖与限制');
  lines.push('');
  lines.push(`- 模型：${options.model}，prompt v${options.promptVersion}`);
  lines.push(`- 会话：共 ${bundle.totals.sessions} 个，模型总结 ${bundle.totals.sessions - report.dropped_sessions} 个，因预算丢弃 ${report.dropped_sessions} 个`);
  lines.push(`- 事件：${bundle.totals.events} 个；历史回补排除 ${bundle.coverage.backfill_events} 个`);
  lines.push('- 工具输出、推理全文与 `content_ref` 正文未发送给模型；模型只看到确定性投影。');
  return `${lines.join('\n')}\n`;
}
