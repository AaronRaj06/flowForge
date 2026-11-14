import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';
import { cx } from './ui';

type Row = { id: string; name: string; updatedAt: string; team: { id: string; name: string } | null; role: string };

export function PipelineList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const current = usePipeline((s) => s.pipelineId);
  const dirty = usePipeline((s) => s.dirty);

  // Refetch after saves (dirty flips back to false) and when switching pipelines.
  useEffect(() => {
    if (dirty) return;
    api<{ pipelines: Row[] }>('/api/pipelines').then((r) => setRows(r.pipelines)).catch(() => setRows([]));
  }, [current, dirty]);

  return (
    <section>
      <h3 className="mb-1.5 px-1 text-[11px] font-medium tracking-wide text-faint uppercase">Your pipelines</h3>
      {rows === null ? (
        <p className="px-1 text-[12px] text-faint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-1 text-[12px] text-faint">Saved pipelines show up here.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((p) => (
            <li key={p.id}>
              <Link
                to={`/p/${p.id}`}
                className={cx('flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-sunken', p.id === current ? 'bg-sunken font-medium text-ink' : 'text-muted')}
                title={p.team ? `${p.team.name} · you’re ${p.role === 'owner' ? 'the creator' : `a ${p.role}`}` : undefined}
              >
                <span className="truncate">{p.name}</span>
                {p.team && <span className="ml-auto shrink-0 rounded bg-surface px-1 text-[10.5px] text-faint">{p.team.name}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
