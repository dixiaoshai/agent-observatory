import { useEffect, useMemo, useState } from 'react';
import { coverageText, turnCost, turnTokens } from '../lib/coverage';
import type { Overview, Selection, Session, Turn } from '../types';
import {
  aggregateCostComplete,
  aggregateCostKnown,
  aggregateTokenKnown,
  aggregateTokenSortValue,
  sessionAggregate,
} from '../lib/sessionAggregate';
import { buildSessionTree, type SessionNode } from '../lib/sessionTree';
import { buildTurnTree, type TurnNode } from '../lib/turnTree';
import {
  firstTurnsBySession,
  flattenSessionRows,
  flattenTurns,
  sessionRowCount,
  type SessionRowEntry,
  type TurnEntry,
} from '../lib/sessionRows';
import { workspaceColor } from '../lib/workspaceColor';
import {
  agentLabel,
  cacheRate,
  formatCost,
  formatDate,
  formatNumber,
  formatPercent,
  projectName,
  sessionName,
  sessionSourceBadge,
  statusLabel,
  turnName,
} from '../lib/format';

type Unit = 'turns' | 'sessions';
type Sort = 'time' | 'tokens' | 'turns' | 'cost' | 'cache';

/** Delay expensive filtering until typing pauses; the input itself stays immediate. */
function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function Sessions({ data, onSelect }: { data: Overview; onSelect: (s: Selection) => void }) {
  const [unit, setUnit] = useState<Unit>('sessions');
  const [sort, setSort] = useState<Sort>('time');
  const [search, setSearch] = useState('');
  const appliedSearch = useDebouncedValue(search.trim());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = useMemo(() => {
    const query = appliedSearch.toLocaleLowerCase();
    if (unit === 'sessions') {
      const promptMatches = new Set(
        data.turns
          .filter((turn) => query && turn.title?.toLocaleLowerCase().includes(query))
          .map((turn) => turn.session_id),
      );
      return data.sessions
        .filter(
          (s) =>
            !query ||
            promptMatches.has(s.id) ||
            `${s.title ?? ''} ${s.native_id ?? ''} ${s.project_name ?? ''} ${s.project} ${s.model} ${s.id}`
              .toLocaleLowerCase()
              .includes(query),
        )
        .slice()
        .sort((a, b) => compareSessions(a, b, sort));
    }
    return data.turns
      .filter(
        (t) =>
          !query ||
          `${t.title ?? ''} ${t.session_title ?? ''} ${t.project_name ?? ''} ${t.project} ${t.model} ${t.native_id} ${t.session_id}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .slice()
      .sort((a, b) => compareTurns(a, b, sort));
  }, [data, unit, sort, appliedSearch]);
  // The session row prompt is the first turn's prompt, not the first sorted row.
  const firstTurns = useMemo(() => firstTurnsBySession(data.turns), [data.turns]);
  const turnTree = useMemo(
    () =>
      buildTurnTree(
        data.turns.slice().sort((a, b) => compareTurns(a, b, sort)),
        appliedSearch
          ? new Set(
              unit === 'sessions'
                ? data.turns
                    .filter((turn) => rows.some((row) => row.id === turn.session_id))
                    .map((turn) => turn.id)
                : rows.map((row) => row.id),
            )
          : undefined,
      ),
    [data.turns, rows, unit, sort, appliedSearch],
  );
  const allTurnEntries = useMemo(() => flattenTurns(turnTree), [turnTree]);
  const rootsBySession = useMemo(() => {
    const roots = new Map<string, TurnNode<Turn>[]>();
    for (const node of turnTree) {
      const id = node.turn.session_id || '';
      const group = roots.get(id) || [];
      group.push(node);
      roots.set(id, group);
    }
    return roots;
  }, [turnTree]);
  const sessionTree = useMemo<SessionNode<Session>[]>(() => {
    if (unit !== 'sessions') return [];
    const sessions = data.sessions.slice().sort((a, b) => compareSessions(a, b, sort));
    // Search keeps matching sessions plus their ancestor context visible.
    return buildSessionTree(
      sessions,
      appliedSearch ? new Set(rows.map((row) => row.id)) : undefined,
    );
  }, [data.sessions, unit, rows, sort, appliedSearch]);
  const allSessionNodes = useMemo(() => {
    const nodes: SessionNode<Session>[] = [];
    const pending = [...sessionTree];
    while (pending.length) {
      const node = pending.pop()!;
      nodes.push(node);
      pending.push(...node.children);
    }
    return nodes;
  }, [sessionTree]);
  const sessionRowTotal = useMemo(
    () => sessionRowCount(sessionTree, rootsBySession),
    [sessionTree, rootsBySession],
  );
  const visibleSessionEntries = useMemo(
    () => flattenSessionRows(sessionTree, rootsBySession, expanded),
    [sessionTree, rootsBySession, expanded],
  );
  const visibleTurnEntries = useMemo(() => flattenTurns(turnTree, expanded), [turnTree, expanded]);
  useEffect(() => {
    if (!appliedSearch) return;
    // Keep matching descendants visible together with their ancestor context.
    setExpanded(
      (previous) =>
        new Set([
          ...previous,
          ...allSessionNodes.map(({ session }) => session.id),
          ...allTurnEntries
            .filter(({ node }) => node.children.length)
            .map(({ node }) => node.turn.id),
        ]),
    );
  }, [appliedSearch, allSessionNodes, allTurnEntries]);

  return (
    <section className="view">
      <div className="toolbar">
        <h2 className="section-label">各轮明细</h2>
        <label>
          查看单位{' '}
          <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            <option value="sessions">会话</option>
            <option value="turns">轮次</option>
          </select>
        </label>
        <label>
          排序{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="time">时间 · 降序</option>
            <option value="tokens">Token · 降序</option>
            <option value="cache">缓存输入 · 降序</option>
            <option value="cost">估算费用 · 降序</option>
            <option value="turns">工具 / 轮次数 · 降序</option>
          </select>
        </label>
        <label>
          搜索{' '}
          <input
            aria-label="搜索会话、Prompt、工作区或模型"
            placeholder="会话、Prompt、工作区或模型"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <>
          <button
            onClick={() =>
              setExpanded(
                (previous) =>
                  new Set([
                    ...previous,
                    ...allSessionNodes
                      .filter(
                        ({ session, children }) =>
                          (rootsBySession.get(session.id)?.length ?? 0) > 0 || children.length > 0,
                      )
                      .map(({ session }) => session.id),
                    ...allTurnEntries
                      .filter(({ node }) => node.children.length)
                      .map(({ node }) => node.turn.id),
                  ]),
              )
            }
            disabled={!rows.length}
          >
            全部展开
          </button>
          <button onClick={() => setExpanded(new Set())} disabled={!expanded.size}>
            全部折叠
          </button>
        </>
        <span className="muted" id="row-count">
          {unit === 'sessions'
            ? `${sessionRowTotal} 组 · ${rows.length} 个${appliedSearch ? '匹配' : ''}会话`
            : `${rows.length} 条`}{' '}
          · 当前样本 {data.summary.token_samples}/{data.summary.turns} 轮有用量
        </span>
      </div>
      <div className="panel detail-table">
        <div className="table-wrap">
          {unit === 'turns' ? (
            <TurnTable
              rows={visibleTurnEntries}
              sessions={data.sessions}
              expanded={expanded}
              onToggle={(id) =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelect={onSelect}
            />
          ) : (
            <SessionTable
              rows={visibleSessionEntries}
              sessions={data.sessions}
              firstTurns={firstTurns}
              expanded={expanded}
              onToggle={(id) =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelect={onSelect}
            />
          )}
        </div>
      </div>
      <p className="footnote">
        费用可能为来源记录成本、账号范围下的免费自动审查或按当前公开 API
        列表价估算，非实际账单；未记录缓存写入时按无单独计费写入估算，
        未还原请求级长上下文加价、服务等级或工具附加费。未知模型或用量不参与估算。缓存和推理不重复计入
        Token 总量；{coverageText(data.summary.request_coverage)}
        。会话行的轮次、工具记录、Token、缓存与费用包含该会话的全部子代理会话；展开后父行与子行是嵌套包含关系，不能相加；父子用量可能重叠时按观测未去重小计显示。时间按{' '}
        {Intl.DateTimeFormat().resolvedOptions().timeZone} 显示。
      </p>
    </section>
  );
}

function compareTurns(a: Turn, b: Turn, sort: Sort): number {
  if (sort === 'cache') return (b.cached_input_tokens ?? -1) - (a.cached_input_tokens ?? -1);
  if (sort === 'cost')
    return (
      (('estimated_cost_known' in b ? b.estimated_cost_known : b.estimated_cost) ?? -1) -
      (('estimated_cost_known' in a ? a.estimated_cost_known : a.estimated_cost) ?? -1)
    );
  if (sort === 'tokens')
    return (
      (b.token_total ?? ('token_known' in b ? b.token_known : null) ?? -1) -
      (a.token_total ?? ('token_known' in a ? a.token_known : null) ?? -1)
    );
  if (sort === 'turns')
    return (b.tools_count ?? b.tools?.length ?? 0) - (a.tools_count ?? a.tools?.length ?? 0);
  return String(b.started_at ?? '').localeCompare(String(a.started_at ?? ''));
}

/** Session sorting ranks whole-subtree totals so parents include their sub-agents. */
function compareSessions(a: Session, b: Session, sort: Sort): number {
  const left = sessionAggregate(a);
  const right = sessionAggregate(b);
  if (sort === 'cache')
    return (
      (right.cache_usage.cached_input_known ?? -1) - (left.cache_usage.cached_input_known ?? -1)
    );
  if (sort === 'cost') return (aggregateCostKnown(right) ?? -1) - (aggregateCostKnown(left) ?? -1);
  if (sort === 'tokens') return aggregateTokenSortValue(right) - aggregateTokenSortValue(left);
  if (sort === 'turns') return right.turns - left.turns;
  return String(b.started_at ?? '').localeCompare(String(a.started_at ?? ''));
}

function TurnIdentity({
  entry,
  session,
  expanded,
  onToggle,
  promptLabel = false,
}: {
  entry: TurnEntry<Turn>;
  session?: Session;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  promptLabel?: boolean;
}) {
  const turn = entry.node.turn;
  const subagent = Boolean(turn.parent_session_id || session?.parent_id);
  const agents = new Set(entry.node.children.map(({ turn }) => turn.session_id)).size;
  return (
    <>
      {entry.node.children.length ? (
        <button
          className="session-toggle"
          aria-label={`${expanded.has(turn.id) ? '折叠' : '展开'}第 ${turn.sequence ?? '?'} 轮的子代理`}
          aria-expanded={expanded.has(turn.id)}
          onClick={() => onToggle(turn.id)}
        >
          {expanded.has(turn.id) ? '▾' : '▸'}
        </button>
      ) : (
        <span className="turn-branch" aria-hidden="true">
          ↳
        </span>
      )}
      <span className={`tag ${subagent ? 'subagent-badge' : 'turn-badge'}`}>
        {subagent ? '子代理' : '轮次'}
      </span>{' '}
      <span className="session-identity" title={`轮次 ID：${turn.native_id}`}>
        {subagent
          ? `${session ? sessionName(session) : turn.session_title || '子代理'} · 第 ${turn.sequence ?? '?'} 轮`
          : promptLabel
            ? turnName(turn)
            : `第 ${turn.sequence ?? '?'} 轮`}
      </span>
      {agents > 0 && <small className="sub session-child-count">{agents} 个子代理</small>}
      {(entry.node.parentMissing || (subagent && !turn.parent_turn_id)) && (
        <small className="sub session-parent-note">
          {turn.parent_turn_id ? '父轮次不在当前范围' : '所属父轮次未知'}
        </small>
      )}
    </>
  );
}

function TurnTable({
  rows,
  sessions,
  expanded,
  onToggle,
  onSelect,
}: {
  rows: TurnEntry<Turn>[];
  sessions: Session[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (s: Selection) => void;
}) {
  if (!rows.length) return <div className="empty">没有匹配轮次，请调整时间或筛选。</div>;
  return (
    <table>
      <thead>
        <tr>
          {[
            '轮次 / 会话',
            'Agent',
            '模型',
            '工作区',
            '时间',
            '输入 Token',
            '总 Token',
            '缓存输入',
            '输出',
            '估算费用 USD',
            '模型调用',
            '状态',
            '详情',
          ].map((x) => (
            <th key={x}>{x}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => {
          const t = entry.node.turn;
          const session = sessions.find((session) => session.id === t.session_id);
          return (
            <tr
              key={t.id}
              className={`workspace-row session-turn-row${t.parent_session_id ? ' subagent-row' : ''}`}
              style={workspaceColor(t)}
              data-turn-id={t.id}
              data-session-id={t.session_id}
              data-parent-turn-id={t.parent_turn_id || undefined}
              data-depth={entry.depth}
            >
              <td style={{ paddingLeft: 8 + Math.min(entry.depth, 8) * 16 }}>
                <TurnIdentity
                  entry={entry}
                  session={session}
                  expanded={expanded}
                  onToggle={onToggle}
                  promptLabel
                />
                <small className="sub" title={`会话 ID：${t.session_native_id || t.session_id}`}>
                  会话：{t.session_title || '未命名会话'}
                </small>
                <small className="sub" title={t.native_id}>
                  轮次 ID：{t.native_id}
                </small>
              </td>
              <td title={t.source || undefined}>{agentLabel(t.source)}</td>
              <td>{t.model}</td>
              <td>
                <span className="project-name" title={t.project || undefined}>
                  {projectName(t)}
                </span>
              </td>
              <td>{formatDate(t.started_at)}</td>
              <td>{formatNumber(t.input_tokens)}</td>
              <td>{turnTokens(t)}</td>
              <td>
                {formatNumber(t.cached_input_tokens)}
                <small className="sub">
                  占输入 {formatPercent(cacheRate(t.input_tokens, t.cached_input_tokens))}
                </small>
              </td>
              <td>{formatNumber(t.output_tokens)}</td>
              <td
                title={
                  t.cost_basis === 'recorded'
                    ? 'pi 记录的请求成本，非实际账单'
                    : t.cost_basis === 'free'
                      ? '账号范围下的免费自动审查，非实际账单'
                      : t.estimated_cost_reason || '按当前公开 API 列表价估算'
                }
              >
                {turnCost(t)}
              </td>
              <td>未知</td>
              <td>
                <span className="tag">{statusLabel(t.status)}</span>
              </td>
              <td>
                <button
                  className="open"
                  aria-label={`查看轮次 ${turnName(t)}`}
                  onClick={() => onSelect({ sessionId: t.session_id ?? '', turnId: t.id })}
                >
                  详情 →
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SessionTable({
  rows,
  sessions,
  firstTurns,
  expanded,
  onToggle,
  onSelect,
}: {
  rows: SessionRowEntry<Session, Turn>[];
  sessions: Session[];
  firstTurns: Map<string, Turn>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (s: Selection) => void;
}) {
  const bySession = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  if (!rows.length) return <div className="empty">没有匹配会话，请调整时间或筛选。</div>;
  return (
    <table className="session-table">
      <thead>
        <tr>
          {[
            '会话 / 轮次',
            '开始时间',
            'Agent',
            '模型',
            '工作区',
            'Prompt',
            '轮次',
            '工具记录',
            'Token 已知小计',
            '缓存输入',
            '估算费用 USD',
            '状态',
            '详情',
          ].map((label) => (
            <th key={label}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => {
          if (entry.kind === 'session') {
            const s = entry.session;
            // Session rows show whole-subtree totals, including descendant sub-agents.
            const aggregate = sessionAggregate(s);
            const cache = aggregate.cache_usage;
            const tokenKnown = aggregateTokenKnown(aggregate);
            const costKnown = aggregateCostKnown(aggregate);
            const isExpanded = expanded.has(s.id);
            const childCount = entry.childSessions.length;
            const firstTurn = firstTurns.get(s.id);
            return (
              <tr
                key={s.id}
                className={`workspace-row session-row${s.parent_id ? ' subagent-row' : ''}${isExpanded ? ' is-expanded' : ''}`}
                style={workspaceColor(s)}
                data-session-id={s.id}
                data-parent-session-id={s.parent_id || undefined}
                data-depth={entry.depth}
              >
                <td
                  className="session-name-cell"
                  style={{ paddingLeft: 8 + Math.min(entry.depth, 8) * 16 }}
                >
                  <button
                    className="session-toggle"
                    aria-label={`${isExpanded ? '折叠' : '展开'}会话 ${sessionName(s)}`}
                    aria-expanded={isExpanded}
                    onClick={() => onToggle(s.id)}
                    disabled={!entry.turnCount && !childCount}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </button>
                  <span className={s.parent_id ? 'tag subagent-badge' : 'badge'}>
                    {s.parent_id ? '子代理' : sessionSourceBadge(s.source)}
                  </span>
                  <span className="session-identity" title={sessionName(s)}>
                    {sessionName(s)}
                  </span>
                  {childCount > 0 && (
                    <small className="sub session-child-count">{childCount} 个子代理</small>
                  )}
                  {entry.parentMissing && (
                    <small className="sub session-parent-note">父会话不在当前范围</small>
                  )}
                </td>
                <td>{formatDate(s.started_at)}</td>
                <td title={s.source || undefined}>{agentLabel(s.source)}</td>
                <td>{s.model}</td>
                <td>
                  <span className="project-name" title={s.project || undefined}>
                    {projectName(s)}
                  </span>
                </td>
                <td className="prompt-cell">
                  {firstTurn ? (
                    <span title={turnName(firstTurn)}>{turnName(firstTurn)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{formatNumber(aggregate.turns)}</td>
                <td>
                  {formatNumber(aggregate.tools)}
                  <small className="sub">已观察记录</small>
                </td>
                <td>
                  {formatNumber(tokenKnown)}
                  <small className="sub">
                    {aggregate.token_samples}/{aggregate.turns} 轮有效
                    {aggregate.aggregation_blocked ? ' · 观测未去重' : ''}
                  </small>
                </td>
                <td className="cache-cell">
                  {formatNumber(cache.cached_input_known)}
                  <small className="sub">
                    占输入 {formatPercent(cache.hit_rate)} · 配对 {cache.samples}/{cache.turns} 轮
                    {!cache.complete && cache.samples > 0 ? ' · 已知小计' : ''}
                    {cache.aggregation_blocked ? ' · 未去重' : ''}
                  </small>
                </td>
                <td className="cost-cell">
                  {formatCost(costKnown)}
                  <small className="sub">
                    {aggregate.cost_samples}/{aggregate.turns} 轮
                    {aggregate.cost_basis === 'recorded'
                      ? '记录成本'
                      : aggregate.cost_basis === 'free'
                        ? '免费'
                        : aggregate.cost_basis === 'mixed'
                          ? '记录/估算/免费'
                          : '可估算'}
                    {!aggregate.aggregation_blocked &&
                    aggregateCostComplete(aggregate) == null &&
                    costKnown != null
                      ? ' · 已知小计'
                      : ''}
                    {aggregate.aggregation_blocked ? ' · 观测未去重' : ''}
                    {aggregate.request_coverage && (
                      <>
                        <br />
                        {coverageText(aggregate.request_coverage)}
                      </>
                    )}
                  </small>
                </td>
                <td>
                  <span className="tag">{statusLabel(s.status)}</span>
                </td>
                <td>
                  <button
                    className="open"
                    aria-label={`查看会话 ${sessionName(s)}`}
                    onClick={() => onSelect({ sessionId: s.id })}
                  >
                    详情 →
                  </button>
                </td>
              </tr>
            );
          }
          const turn = entry.node.turn;
          const session = bySession.get(turn.session_id || '');
          return (
            <tr
              key={turn.id}
              className={`workspace-row session-turn-row${turn.parent_session_id ? ' subagent-row' : ''}`}
              style={workspaceColor(turn)}
              data-session-id={turn.session_id}
              data-turn-id={turn.id}
              data-parent-turn-id={turn.parent_turn_id || undefined}
              data-depth={entry.depth}
            >
              <td
                className="turn-name-cell"
                style={{ paddingLeft: 8 + Math.min(entry.depth, 8) * 16 }}
              >
                <TurnIdentity
                  entry={entry}
                  session={session}
                  expanded={expanded}
                  onToggle={onToggle}
                />
              </td>
              <td>{formatDate(turn.started_at)}</td>
              <td title={turn.source || undefined}>{agentLabel(turn.source)}</td>
              <td>{turn.model}</td>
              <td>
                <span className="project-name" title={turn.project || undefined}>
                  {projectName(turn)}
                </span>
              </td>
              <td className="prompt-cell">
                <span title={turnName(turn)}>{turnName(turn)}</span>
              </td>
              <td className="muted">—</td>
              <td>
                {formatNumber(turn.tools_count ?? turn.tools?.length)}
                <small className="sub">已观察记录</small>
              </td>
              <td>{turnTokens(turn)}</td>
              <td className="cache-cell">
                {formatNumber(turn.cached_input_tokens)}
                <small className="sub">
                  占输入 {formatPercent(cacheRate(turn.input_tokens, turn.cached_input_tokens))}
                </small>
              </td>
              <td
                title={
                  turn.cost_basis === 'recorded'
                    ? 'pi 记录的请求成本，非实际账单'
                    : turn.cost_basis === 'free'
                      ? '账号范围下的免费自动审查，非实际账单'
                      : turn.estimated_cost_reason || '按当前公开 API 列表价估算'
                }
              >
                {turnCost(turn)}
              </td>
              <td>
                <span className="tag">{statusLabel(turn.status)}</span>
              </td>
              <td>
                <button
                  className="open"
                  aria-label={`查看轮次 ${turnName(turn)}`}
                  onClick={() => onSelect({ sessionId: turn.session_id || '', turnId: turn.id })}
                >
                  详情 →
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
