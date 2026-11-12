import { useEffect, useMemo, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import cronstrue from 'cronstrue';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { Button, CopyField, Input, Label, Modal, StatusDot, cx } from './ui';

type Deployment = {
  id: string;
  type: 'cron' | 'webhook' | 'api';
  cronExpression: string | null;
  webhookSecret?: string | null;
  syncTimeout: number;
  active: boolean;
  lastRunAt: string | null;
  url?: string;
};
type RunRow = { id: string; status: string; startedAt: string; durationMs: number | null };

const describeCron = (expr: string) => {
  try {
    return { ok: true, text: cronstrue.toString(expr, { verbose: true }) };
  } catch (e) {
    return { ok: false, text: String(e).replace(/^Error: /, '') };
  }
};

function DeploymentRuns({ id }: { id: string }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  useEffect(() => {
    api<{ runs: RunRow[] }>(`/api/deployments/${id}/runs`).then((r) => setRuns(r.runs)).catch(() => setRuns([]));
  }, [id]);
  if (!runs) return null;
  if (!runs.length) return <p className="text-[12px] text-faint">No runs yet.</p>;
  return (
    <ul className="max-h-40 divide-y divide-line overflow-auto rounded-md border border-line">
      {runs.map((r) => (
        <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
          <StatusDot status={r.status} />
          <span className="flex-1 text-muted">{new Date(r.startedAt).toLocaleString()}</span>
          <span className="font-mono text-faint tabular-nums">{r.durationMs == null ? '…' : `${(r.durationMs / 1000).toFixed(1)}s`}</span>
        </li>
      ))}
    </ul>
  );
}

function DeploymentCard({ d, onChange }: { d: Deployment; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api(`/api/deployments/${d.id}`, { method: 'PATCH', json: { active: !d.active } });
      onChange();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api(`/api/deployments/${d.id}`, { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
    onChange();
  };
  const curl =
    d.type === 'cron'
      ? null
      : `curl -X POST '${d.url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Webhook-Secret: ${d.webhookSecret}' \\\n  -d '{"text": "hello"}'`;

  return (
    <div className="space-y-3 rounded-lg border border-line p-3.5">
      <div className="flex items-center gap-2">
        <span className={cx('size-2 rounded-full', d.active ? 'bg-st-success' : 'bg-st-pending')} />
        <span className="flex-1 text-[13px] font-medium">
          {d.type === 'cron' ? describeCron(d.cronExpression!).text : d.type === 'webhook' ? 'Webhook (async)' : `REST API (sync, ${d.syncTimeout}s timeout)`}
        </span>
        <Button size="sm" onClick={toggle} loading={busy}>
          {d.active ? 'Pause' : 'Resume'}
        </Button>
        <Button size="sm" variant="danger" onClick={remove}>
          Delete
        </Button>
      </div>
      {d.type === 'cron' && <p className="font-mono text-[12px] text-muted">{d.cronExpression}</p>}
      {d.type !== 'cron' && (
        <>
          <div>
            <Label>Endpoint</Label>
            <CopyField value={d.url!} />
          </div>
          <div>
            <Label hint="Send it in the X-Webhook-Secret header. Or sign the raw body: X-Webhook-Signature: sha256=<hex HMAC-SHA256(secret, body)>.">Secret</Label>
            <CopyField value={d.webhookSecret!} />
          </div>
          <div>
            <Label hint={d.type === 'webhook' ? 'Returns { runId } at once. Poll GET /api/runs/:runId or stream /api/runs/:runId/stream.' : 'Waits for the run and returns the final context as JSON.'}>Example</Label>
            <pre className="overflow-x-auto rounded-md bg-ink p-3 font-mono text-[11.5px] leading-relaxed text-white">{curl}</pre>
          </div>
        </>
      )}
      <div>
        <Label>Recent runs</Label>
        <DeploymentRuns id={d.id} />
      </div>
    </div>
  );
}

export function DeployModal({ open, onOpenChange, pipelineId }: { open: boolean; onOpenChange: (o: boolean) => void; pipelineId: string }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [timeout, setTimeoutSecs] = useState(30);
  const [creating, setCreating] = useState(false);
  const preview = useMemo(() => describeCron(cron), [cron]);

  const load = () => api<{ deployments: Deployment[] }>(`/api/deployments?pipelineId=${pipelineId}`).then((r) => setDeployments(r.deployments)).catch(() => {});
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pipelineId]);

  const create = async (body: Record<string, unknown>) => {
    setCreating(true);
    try {
      await api('/api/deployments', { method: 'POST', json: { pipelineId, ...body } });
      toast.success('Deployed');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const list = (type: Deployment['type']) => deployments.filter((d) => d.type === type);
  const tab = 'press rounded-md px-3 py-1.5 text-[13px] font-medium text-muted data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]';

  return (
    <Modal open={open} onOpenChange={onOpenChange} wide title="Deploy pipeline" description="Deployments run the last saved version of this pipeline.">
      <Tabs.Root defaultValue="schedule">
        <Tabs.List className="mb-4 inline-flex gap-1 rounded-lg bg-sunken p-1" aria-label="Deployment type">
          <Tabs.Trigger value="schedule" className={tab}>Schedule</Tabs.Trigger>
          <Tabs.Trigger value="webhook" className={tab}>Webhook</Tabs.Trigger>
          <Tabs.Trigger value="api" className={tab}>API</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="schedule" className="space-y-4 focus:outline-none">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              create({ type: 'cron', cronExpression: cron.trim() });
            }}
          >
            <div className="flex-1">
              <Label htmlFor="cron">Cron expression</Label>
              <Input id="cron" value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono text-[12px]" />
            </div>
            <Button type="submit" variant="primary" loading={creating} disabled={!preview.ok}>
              Add schedule
            </Button>
          </form>
          <p className={cx('-mt-2 text-[12px]', preview.ok ? 'text-muted' : 'text-st-error')}>{preview.text}</p>
          {list('cron').map((d) => <DeploymentCard key={d.id} d={d} onChange={load} />)}
        </Tabs.Content>

        <Tabs.Content value="webhook" className="space-y-4 focus:outline-none">
          <p className="text-[13px] text-muted">POST any JSON to the URL; it becomes the run’s <code className="font-mono">{'{{input}}'}</code> and the pipeline runs in the background.</p>
          {list('webhook').length === 0 && (
            <Button variant="primary" loading={creating} onClick={() => create({ type: 'webhook' })}>
              Create webhook
            </Button>
          )}
          {list('webhook').map((d) => <DeploymentCard key={d.id} d={d} onChange={load} />)}
        </Tabs.Content>

        <Tabs.Content value="api" className="space-y-4 focus:outline-none">
          <p className="text-[13px] text-muted">Call the pipeline like a function: the request waits for the run and returns its output.</p>
          {list('api').length === 0 && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                create({ type: 'api', syncTimeout: timeout });
              }}
            >
              <div className="w-40">
                <Label htmlFor="timeout">Timeout (seconds)</Label>
                <Input id="timeout" type="number" min={1} max={120} value={timeout} onChange={(e) => setTimeoutSecs(Number(e.target.value))} />
              </div>
              <Button type="submit" variant="primary" loading={creating}>
                Create API endpoint
              </Button>
            </form>
          )}
          {list('api').map((d) => <DeploymentCard key={d.id} d={d} onChange={load} />)}
        </Tabs.Content>
      </Tabs.Root>
    </Modal>
  );
}
