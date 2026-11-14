import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

type PipelineStats = {
  costPerMillion: number | null;
  pipelines: { pipelineId: string; name: string; team: string | null; runs: number; successRate: number; failed: number; avgMs: number | null; tokens: number; cost: number | null }[];
  failures: { id: string; pipelineId: string; name: string; error: string | null; startedAt: string; deploymentId: string | null }[];
};
const secs = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

type Usage = { today: number; budget: number; costPerMillion: number | null; days: { day: string; tokens: number; runs: number }[] };

export function UsagePage() {
  const [u, setU] = useState<Usage | null>(null);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  useEffect(() => {
    api<Usage>('/api/usage').then(setU).catch(() => {});
    api<PipelineStats>('/api/usage/pipelines').then(setStats).catch(() => {});
  }, []);
  if (!u) return <div className="p-8 text-[13px] text-faint">Loading…</div>;

  // Fill the last 14 days so empty days show as gaps, not missing bars.
  const byDay = new Map(u.days.map((d) => [new Date(d.day).toDateString(), d]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (13 - i));
    return { date, ...(byDay.get(date.toDateString()) ?? { tokens: 0, runs: 0 }) };
  });
  const max = Math.max(...days.map((d) => d.tokens), 1);
  const pct = Math.min(100, (u.today / u.budget) * 100);
  const totalRuns = days.reduce((s, d) => s + d.runs, 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-[20px] font-semibold">Usage</h1>
      <p className="mt-1 mb-6 text-[13px] text-muted">Tokens used by LLM blocks. Runs are refused once today’s budget is spent; it resets at midnight.</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4 sm:col-span-2">
          <div className="text-[12px] text-muted">Today</div>
          <div className="mt-1 text-[24px] font-semibold tabular-nums">
            {u.today.toLocaleString()} <span className="text-[14px] font-normal text-faint">/ {u.budget.toLocaleString()} tokens</span>
          </div>
          {u.costPerMillion && <div className="mt-0.5 text-[12px] text-muted">About ${((u.today / 1e6) * u.costPerMillion).toFixed(4)} today</div>}
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full ${pct >= 90 ? 'bg-st-error' : 'bg-ink'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-[12px] text-muted">Runs, last 14 days</div>
          <div className="mt-1 text-[24px] font-semibold tabular-nums">{totalRuns.toLocaleString()}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-line bg-surface p-4">
        <div className="mb-4 text-[12px] text-muted">Tokens per day</div>
        <div className="flex h-40 items-end gap-1.5">
          {days.map((d) => (
            <div key={d.date.toISOString()} className="group relative flex h-full flex-1 flex-col justify-end">
              <div className="rounded-t-[3px] bg-ink/85 group-hover:bg-accent" style={{ height: `${(d.tokens / max) * 100}%`, minHeight: d.tokens ? 2 : 0 }} />
              <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 text-[11px] whitespace-nowrap text-white group-hover:block">
                {d.tokens.toLocaleString()} tokens · {d.runs} runs
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-faint">
          <span>{days[0].date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          <span>Today</span>
        </div>
      </div>

      <h2 className="mt-8 mb-2 text-[13px] font-medium text-muted">Pipelines, last 14 days</h2>
      {!stats ? (
        <p className="text-[13px] text-faint">Loading…</p>
      ) : stats.pipelines.length === 0 ? (
        <p className="text-[13px] text-faint">No saved pipeline has run yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Pipeline</th>
                <th className="px-3 py-2 text-right font-medium">Runs</th>
                <th className="px-3 py-2 text-right font-medium">Success</th>
                <th className="px-3 py-2 text-right font-medium">Avg time</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                {stats.costPerMillion && <th className="px-4 py-2 text-right font-medium">Cost</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line tabular-nums">
              {stats.pipelines.map((p) => (
                <tr key={p.pipelineId}>
                  <td className="max-w-[16rem] truncate px-4 py-2">
                    <Link to={`/p/${p.pipelineId}`} className="hover:underline">{p.name}</Link>
                    {p.team && <span className="ml-1.5 text-[11px] text-faint">{p.team}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{p.runs}</td>
                  <td className={`px-3 py-2 text-right ${p.successRate < 0.9 ? 'text-st-error' : ''}`}>{Math.round(p.successRate * 100)}%</td>
                  <td className="px-3 py-2 text-right">{secs(p.avgMs)}</td>
                  <td className="px-3 py-2 text-right">{p.tokens.toLocaleString()}</td>
                  {stats.costPerMillion && <td className="px-4 py-2 text-right">${(p.cost ?? 0).toFixed(4)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-8 mb-2 text-[13px] font-medium text-muted">Recent failures</h2>
      {stats && stats.failures.length === 0 ? (
        <p className="text-[13px] text-faint">No failed runs in the last 14 days.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {stats?.failures.map((f) => (
            <li key={f.id} className="flex gap-3 px-4 py-2 text-[13px]">
              <Link to={`/p/${f.pipelineId}`} className="shrink-0 font-medium hover:underline">{f.name}</Link>
              <span className="min-w-0 flex-1 truncate text-st-error" title={f.error ?? ''}>{f.error}</span>
              {f.deploymentId && <span className="shrink-0 rounded bg-sunken px-1.5 text-[11px] text-muted">deployed</span>}
              <time className="shrink-0 text-[12px] text-faint" dateTime={f.startedAt}>{new Date(f.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[12px] text-faint">To be alerted when a pipeline fails, give it an error workflow (Deploy → On failure) that emails or posts to Slack, Discord or Telegram.</p>
    </div>
  );
}
