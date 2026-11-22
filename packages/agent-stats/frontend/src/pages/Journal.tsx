import { useEffect, useState } from 'react';
import { getJournalDay, getJournalDays } from '../lib/api';
import type { JournalDay, JournalDays } from '../types';

type Result<T> = { data: T } | { error: string } | null;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function DailyReport({ date }: { date: string }) {
  const [result, setResult] = useState<Result<JournalDay>>(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void getJournalDay(date, signal).then(
      (data) => {
        if (!signal.aborted) setResult({ data });
      },
      (error: unknown) => {
        if (!signal.aborted) setResult({ error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [date]);

  if (!result) return <p role="status">正在读取 {date} 的日报…</p>;
  if ('error' in result) return <p role="alert">日报读取失败：{result.error}</p>;
  return (
    <article aria-label={`${result.data.date} 日报`}>
      <h3>{result.data.date} · Markdown 原文</h3>
      <pre className="journal-report">{result.data.markdown}</pre>
    </article>
  );
}

export function Journal() {
  const [result, setResult] = useState<Result<JournalDays>>(null);
  const [date, setDate] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void getJournalDays(signal).then(
      (data) => {
        if (!signal.aborted) {
          setDate((previous) => (data.days.includes(previous) ? previous : (data.days[0] ?? '')));
          setResult({ data });
        }
      },
      (error: unknown) => {
        if (!signal.aborted) setResult({ error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [revision]);

  return (
    <section className="panel journal" aria-labelledby="journal-title">
      <div className="panel-head">
        <div>
          <h2 id="journal-title">Agent Journal 日报</h2>
          <p className="muted">按日报日期查看已生成的总结，不受统计筛选影响。</p>
        </div>
        <button
          type="button"
          disabled={!result || ('data' in result && !result.data.enabled)}
          onClick={() => {
            setResult(null);
            setRevision((current) => current + 1);
          }}
        >
          重新读取日报
        </button>
      </div>
      {!result ? (
        <p role="status">正在读取日报日期…</p>
      ) : 'error' in result ? (
        <p role="alert">日报日期读取失败：{result.error}</p>
      ) : !result.data.enabled ? (
        <p>
          尚未配置日报目录。请启动 Stats 时用 <code>--journal-dir</code> 指定 Journal 的输出目录。
        </p>
      ) : !date ? (
        <p>还没有正式日报。日报生成后可点「重新读取日报」。</p>
      ) : (
        <>
          <div className="toolbar">
            <label>
              日报日期
              <select value={date} onChange={(event) => setDate(event.target.value)}>
                {result.data.days.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DailyReport key={date} date={date} />
        </>
      )}
    </section>
  );
}
