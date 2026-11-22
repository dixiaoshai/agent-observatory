import { useEffect, useRef, useState } from 'react';
import { getKnowledgeStatus, readKnowledge, searchKnowledge } from '../lib/api';
import type { KnowledgeRecord, KnowledgeResult } from '../types';

function KnowledgeHit({ result }: { result: KnowledgeResult }) {
  const [expanded, setExpanded] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<KnowledgeRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  function collapse() {
    active.current?.abort();
    active.current = null;
    setExpanded(false);
    setLoading(false);
    setRecord(null);
    setError(null);
  }

  async function verify() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setAttempted(true);
    setExpanded(true);
    setLoading(true);
    setRecord(null);
    setError(null);
    try {
      const response = await readKnowledge(result.id, result.project_id, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setRecord(response.record);
    } catch (err) {
      if (!controller.signal.aborted && active.current === controller)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted && active.current === controller) setLoading(false);
    }
  }

  return (
    <article className="knowledge-result">
      <h3>
        搜索片段：{result.path} · {result.start_line}–{result.end_line} 行
      </h3>
      <p className="muted">
        项目：{result.project_id} · 来源：{result.source_id}
      </p>
      {!attempted && <pre>{result.content}</pre>}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => (expanded ? collapse() : void verify())}
      >
        {expanded ? '收起来源' : '查看来源'}
      </button>
      {expanded && (
        <div className="knowledge-verification">
          {loading && <p role="status">正在重新核验来源…</p>}
          {error && (
            <div className="notice" role="alert">
              来源核验失败：{error} <button onClick={() => void verify()}>重试</button>
            </div>
          )}
          {record && (
            <>
              <p>
                已重新核验的片段（非完整文件）：{record.path} · {record.start_line}–
                {record.end_line} 行
              </p>
              <pre>{record.content}</pre>
              <p className="knowledge-metadata">
                来源：{record.source_id} · 项目：{record.project_id}
                <br />
                来源版本：{record.source_version_id}
                <br />
                文件 SHA-256：{record.content_hash}
                <br />
                Git commit：{record.git_commit ?? '未知'}
              </p>
            </>
          )}
        </div>
      )}
      {attempted && !expanded && <p className="muted">已收起片段；再次查看将重新核验来源。</p>}
    </article>
  );
}

export function Knowledge() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [results, setResults] = useState<KnowledgeResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setEnabled(null);
    setStatusError(null);
    getKnowledgeStatus(controller.signal).then(
      (status) => {
        if (!controller.signal.aborted) setEnabled(status.enabled);
      },
      (err: unknown) => {
        if (!controller.signal.aborted)
          setStatusError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => controller.abort();
  }, [statusAttempt]);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );

  function invalidate() {
    active.current?.abort();
    active.current = null;
    setLoading(false);
    setResults(null);
    setError(null);
  }
  async function search() {
    const text = query.trim();
    if (!text || loading) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const response = await searchKnowledge(text, project.trim() || undefined, controller.signal);
      if (!controller.signal.aborted && active.current === controller)
        setResults(response.results.slice(0, 10));
    } catch (err) {
      if (!controller.signal.aborted && active.current === controller)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted && active.current === controller) setLoading(false);
    }
  }

  return (
    <section className="panel knowledge">
      <h2>Knowledge</h2>
      <p className="muted">
        检索已由 Agent Knowledge
        索引的文档或代码。结果来自本地配置的来源，采用前请核对项目和文件版本。
      </p>
      {statusError ? (
        <div className="notice" role="alert">
          状态请求失败：{statusError}{' '}
          <button onClick={() => setStatusAttempt((n) => n + 1)}>重试</button>
        </div>
      ) : enabled === null ? (
        <p role="status">正在检查 Knowledge 配置…</p>
      ) : !enabled ? (
        <p>
          Knowledge 未启用。请用 <code>agent-stats serve --knowledge-config PATH</code> 启动服务。
        </p>
      ) : (
        <>
          <form
            className="knowledge-form"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <label>
              搜索{' '}
              <input
                value={query}
                onChange={(event) => {
                  invalidate();
                  setQuery(event.target.value);
                }}
                maxLength={256}
                required
              />
            </label>
            <label>
              项目 ID（可选）{' '}
              <input
                value={project}
                onChange={(event) => {
                  invalidate();
                  setProject(event.target.value);
                }}
                maxLength={200}
              />
            </label>
            <button type="submit" disabled={loading || !query.trim()}>
              搜索
            </button>
          </form>
          {loading && <p role="status">正在搜索…</p>}
          {error && (
            <div className="notice" role="alert">
              搜索失败：{error} <button onClick={() => void search()}>重试</button>
            </div>
          )}
          {results &&
            (results.length === 0 ? (
              <p className="empty">没有匹配结果。</p>
            ) : (
              <div>
                {results.map((result, index) => (
                  <KnowledgeHit key={`${result.id}-${index}`} result={result} />
                ))}
              </div>
            ))}
        </>
      )}
    </section>
  );
}
