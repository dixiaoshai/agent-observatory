import { useEffect, useMemo, useState } from 'react';
import type { Filters, Page, Selection } from './types';
import { FiltersBar, type FilterControls, type ProjectOption } from './components/FiltersBar';
import { SessionDialog } from './components/SessionDialog';
import { useStats } from './hooks/useStats';
import { formatDate, projectName, timeZone } from './lib/format';
import { pageFromHash, pageHref } from './lib/pageRoute';
import { Journal } from './pages/Journal';
import { Overview } from './pages/Overview';
import { Sessions } from './pages/Sessions';
import { Source } from './pages/Source';

const initialFilters: FilterControls = {
  range: '7',
  source: '',
  project: '',
  model: '',
  start: '',
  end: '',
};
const emptyFilters: Filters = {};
const pages: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: '各轮明细' },
  { id: 'journal', label: 'Agent Journal 日报' },
  { id: 'source', label: '来源与覆盖' },
];

export default function App() {
  const [page, setPage] = useState(() => pageFromHash(window.location.hash));
  const isStatsPage = page !== 'journal';
  const [controls, setControls] = useState(initialFilters);
  const [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => {
    const syncPage = () => {
      const next = pageFromHash(window.location.hash);
      setPage(next);
      if (next !== 'sessions') setSelection(null);
    };
    window.addEventListener('hashchange', syncPage);
    syncPage();
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);
  const [facets, setFacets] = useState<{
    sources: string[];
    projects: ProjectOption[];
    models: string[];
  }>({
    sources: [],
    projects: [],
    models: [],
  });
  const filters = useMemo<Filters>(() => {
    const result: Filters = {};
    if (controls.range === 'custom') {
      if (controls.start) result.start = new Date(controls.start).toISOString();
      if (controls.end) result.end = new Date(controls.end).toISOString();
    } else if (controls.range !== 'all')
      result.start = new Date(Date.now() - Number(controls.range) * 86400000).toISOString();
    if (controls.source) result.source = controls.source;
    if (controls.project) result.project = controls.project;
    if (controls.model) result.model = controls.model;
    return result;
  }, [controls]);
  const { data, error, loading, refreshing, refresh, reload, messages, queryTime } = useStats(
    filters,
    isStatsPage,
  );
  useEffect(() => {
    if (!data) return;
    setFacets((previous) => ({
      sources: [
        ...new Set([
          ...previous.sources,
          ...data.sessions.map((session) => session.source).filter(Boolean),
        ]),
      ].sort(),
      projects: [
        ...new Map([
          ...previous.projects.map((project) => [project.path, project] as const),
          ...data.sessions
            .filter((s) => s.project)
            .map((s) => [s.project!, { path: s.project!, name: projectName(s) }] as const),
        ]).values(),
      ].sort((a, b) => a.name.localeCompare(b.name)),
      models: [...new Set([...previous.models, ...data.groups.map((g) => g.model)])].sort(),
    }));
  }, [data]);
  const warnings = [...new Set([...(data?.warnings ?? []), ...messages])];
  const select = (next: Selection) => {
    if (window.location.hash !== pageHref.sessions) window.location.hash = pageHref.sessions;
    setSelection(next);
  };
  return (
    <>
      <main className="shell">
        <header className="app-header">
          <div>
            <h1>Agent token stats</h1>
            <p>Codex / pi / dsh · 本地会话数据 · 手动刷新采集 · 仅 127.0.0.1</p>
          </div>
          {isStatsPage && (
            <div className="header-actions">
              <button onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? '正在采集…' : '刷新采集'}
              </button>
              <span className="updated">
                {queryTime ? `查询于 ${formatDate(queryTime)}` : '等待数据'}
                <br />
                {timeZone}
              </span>
            </div>
          )}
        </header>
        {isStatsPage && (
          <FiltersBar
            value={controls}
            sources={facets.sources}
            projects={facets.projects}
            models={facets.models}
            onChange={setControls}
          />
        )}
        <nav className="tabs" aria-label="分析页面">
          {pages.map((item) => (
            <a
              key={item.id}
              className={`nav${page === item.id ? ' active' : ''}`}
              aria-current={page === item.id ? 'page' : undefined}
              href={pageHref[item.id]}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {isStatsPage && error && (
          <div className="notice" role="alert">
            数据请求失败：{error} <button onClick={reload}>重新查询</button>
            {data && <p>当前仍显示上一次成功查询的结果。</p>}
          </div>
        )}
        {isStatsPage && loading && (
          <p className="loading-state" role="status">
            {data ? '正在更新筛选结果，暂显示上次查询数据…' : '正在读取本机统计数据…'}
          </p>
        )}
        {isStatsPage && warnings.length > 0 && (
          <details className="notice">
            <summary>{warnings.length} 条数据提醒 · 查看采集或覆盖说明</summary>
            <ul>
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
        {page === 'journal' ? (
          <Journal />
        ) : page === 'source' ? (
          <Source />
        ) : data ? (
          <section className="view" aria-busy={loading}>
            {page === 'overview' ? (
              <Overview data={data} onSelect={select} />
            ) : (
              <Sessions data={data} onSelect={select} />
            )}
          </section>
        ) : !loading && !error ? (
          <div className="empty">暂无统计数据，请刷新采集。</div>
        ) : null}
      </main>
      <SessionDialog
        selection={selection}
        filters={data?.filters ?? emptyFilters}
        onClose={() => setSelection(null)}
      />
    </>
  );
}
