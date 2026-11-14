import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { usePipeline } from '../store/pipelineStore';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { Button, Label, StatusDot, Textarea } from './ui';

export const useRunInput = create<{ input: string; setInput: (s: string) => void }>((set) => ({
  input: '',
  setInput: (input) => set({ input }),
}));

/** Text that parses as JSON is sent as JSON; anything else as a plain string. */
export const parseRunInput = (s: string): unknown => {
  if (!s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

type RunRow = { id: string; status: string; error: string | null; tokensUsed: number; startedAt: string; finishedAt: string | null; deploymentId: string | null };

/** Approve / Reject for a run paused at an approval block. */
function ApprovalBox({ runId, request }: { runId: string; request: string }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const decide = async (approved: boolean) => {
    setBusy(approved ? 'yes' : 'no');
    try {
      await api(`/api/runs/${runId}/approval`, { method: 'POST', json: { approved, comment } });
      usePipeline.getState().resumeRun();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-st-waiting/50 p-3">
      <p className="text-[13px] font-medium">Approval needed</p>
      <p className="text-[13px] whitespace-pre-wrap break-words text-muted">{request || 'No details given.'}</p>
      <Textarea aria-label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)" />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy === 'yes'} disabled={!!busy} onClick={() => decide(true)}>
          Approve
        </Button>
        <Button size="sm" loading={busy === 'no'} disabled={!!busy} onClick={() => decide(false)}>
          Reject
        </Button>
      </div>
    </div>
  );
}

const duration = (r: RunRow) => (r.status === 'WAITING' ? '—' : r.finishedAt ? `${((+new Date(r.finishedAt) - +new Date(r.startedAt)) / 1000).toFixed(1)}s` : '…');

export function RunPanel() {
  const { input, setInput } = useRunInput();
  const run = usePipeline((s) => s.run);
  const pipelineId = usePipeline((s) => s.pipelineId);
  const [history, setHistory] = useState<RunRow[]>([]);

  useEffect(() => {
    if (!pipelineId) return setHistory([]);
    api<{ runs: RunRow[] }>(`/api/runs?pipelineId=${pipelineId}`).then((r) => setHistory(r.runs)).catch(() => {});
  }, [pipelineId, run.status]);

  return (
    <div className="space-y-5 p-4">
      <div>
        <Label htmlFor="run-input" hint="Available as {{input}}. JSON is parsed, so {{input.field}} works.">
          Run input
        </Label>
        <Textarea id="run-input" mono value={input} onChange={(e) => setInput(e.target.value)} placeholder='"Paste text" or { "field": "value" }' />
      </div>

      {run.status !== 'idle' && (
        <div>
          <Label>Last run</Label>
          <div className="mb-2 flex items-center gap-2 text-[13px]">
            <StatusDot status={run.status} />
            <span className="font-medium">{run.status === 'running' ? 'Running…' : run.status === 'SUCCESS' ? 'Succeeded' : run.status === 'ERROR' ? 'Failed' : run.status === 'WAITING' ? 'Waiting for approval' : run.status}</span>
          </div>
          {run.status === 'WAITING' && run.runId && <ApprovalBox runId={run.runId} request={run.waiting?.request ?? ''} />}
          {run.error && <p className="mb-2 text-[12px] text-st-error">{run.error}</p>}
          {run.output != null && run.status !== 'WAITING' && (
            <pre className="max-h-72 overflow-auto rounded-md bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">
              {JSON.stringify(run.output, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div>
        <Label>Run history</Label>
        {!pipelineId ? (
          <p className="text-[12px] text-faint">Save the pipeline to keep a run history.</p>
        ) : history.length === 0 ? (
          <p className="text-[12px] text-faint">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {history.slice(0, 20).map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                <StatusDot status={r.status} />
                <span className="flex-1 text-muted">{new Date(r.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                {r.deploymentId && <span className="rounded bg-sunken px-1.5 text-[11px] text-muted">deployed</span>}
                <span className="font-mono text-faint tabular-nums">{duration(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
