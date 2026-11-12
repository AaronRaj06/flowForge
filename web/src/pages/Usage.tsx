import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Usage = { today: number; budget: number; days: { day: string; tokens: number; runs: number }[] };

export function UsagePage() {
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    api<Usage>('/api/usage').then(setU).catch(() => {});
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
    </div>
  );
}
