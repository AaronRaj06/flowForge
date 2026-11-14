import { useEffect, useMemo, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import cronstrue from 'cronstrue';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { usePipeline } from '../store/pipelineStore';
import { Button, CopyField, Input, Label, Modal, Select, StatusDot, cx } from './ui';

type Deployment = {
  id: string;
  type: 'cron' | 'webhook' | 'api' | 'form';
  formFields?: string[];
  formFile?: boolean;
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
    d.type === 'cron' || d.type === 'form'
      ? null
      : `curl -X POST '${d.url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Webhook-Secret: ${d.webhookSecret}' \\\n  -d '{"text": "hello"}'`;

  return (
    <div className="space-y-3 rounded-lg border border-line p-3.5">
      <div className="flex items-center gap-2">
        <span className={cx('size-2 rounded-full', d.active ? 'bg-st-success' : 'bg-st-pending')} />
        <span className="flex-1 text-[13px] font-medium">
          {d.type === 'cron' ? describeCron(d.cronExpression!).text : d.type === 'form' ? `Form: ${d.formFields?.join(', ')}${d.formFile ? ' + file' : ''}` : d.type === 'webhook' ? 'Webhook (async)' : `REST API (sync, ${d.syncTimeout}s timeout)`}
        </span>
        <Button size="sm" onClick={toggle} loading={busy}>
          {d.active ? 'Pause' : 'Resume'}
        </Button>
        <Button size="sm" variant="danger" onClick={remove}>
          Delete
        </Button>
      </div>
      {d.type === 'cron' && <p className="font-mono text-[12px] text-muted">{d.cronExpression}</p>}
      {d.type === 'form' && (
        <div>
          <Label hint="Anyone with the link can submit. Each submission starts a run; the fields (and file text) are its {{input}}.">Public form</Label>
          <CopyField value={d.url!} />
        </div>
      )}
      {d.type !== 'cron' && d.type !== 'form' && (
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

type Cost = {
  sampleRuns: number;
  avgTokensPerRun: number;
  perNode: Record<string, number>;
  schedules: { deploymentId: string; cronExpression: string; runsPerMonth: number; tokensPerMonth: number }[];
  maxTokensPerRun: number | null;
  costPerMillion: number | null;
};

const fmtTokens = (n: number) => n.toLocaleString();
const money = (tokens: number, perMillion: number | null) => (perMillion ? ` (about $${((tokens / 1e6) * perMillion).toFixed(tokens * perMillion < 1e6 ? 4 : 2)})` : '');

/** What this pipeline costs per run and per schedule, from its recent runs, plus the per-run token limit. */
function CostTab({ pipelineId }: { pipelineId: string }) {
  const [cost, setCost] = useState<Cost | null>(null);
  const [limit, setLimit] = useState('');
  const [saving, setSaving] = useState(false);
  const nodes = usePipeline((s) => s.nodes);
  useEffect(() => {
    api<Cost>(`/api/pipelines/${pipelineId}/cost`)
      .then((c) => {
        setCost(c);
        setLimit(c.maxTokensPerRun ? String(c.maxTokensPerRun) : '');
      })
      .catch(() => {});
  }, [pipelineId]);
  if (!cost) return null;
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id.slice(0, 8);
  const saveLimit = async () => {
    setSaving(true);
    try {
      await api(`/api/pipelines/${pipelineId}`, { method: 'PUT', json: { maxTokensPerRun: limit.trim() ? Number(limit) : null } });
      toast.success(limit.trim() ? 'Token limit saved' : 'Token limit removed');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      {cost.sampleRuns === 0 ? (
        <p className="text-[13px] text-muted">No successful runs yet. Run the pipeline once to see what it costs.</p>
      ) : (
        <>
          <p className="text-[13px]">
            A run uses about <span className="font-semibold tabular-nums">{fmtTokens(cost.avgTokensPerRun)} tokens</span>
            {money(cost.avgTokensPerRun, cost.costPerMillion)}, averaged over the last {cost.sampleRuns} successful run{cost.sampleRuns === 1 ? '' : 's'}.
          </p>
          {Object.keys(cost.perNode).length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line">
              {Object.entries(cost.perNode)
                .sort((a, b) => b[1] - a[1])
                .map(([id, t]) => (
                  <li key={id} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                    <span className="flex-1 font-mono">{nameOf(id)}</span>
                    <span className="tabular-nums text-muted">{fmtTokens(t)} tokens</span>
                    <span className="w-12 text-right tabular-nums text-faint">{cost.avgTokensPerRun ? Math.round((t / cost.avgTokensPerRun) * 100) : 0}%</span>
                  </li>
                ))}
            </ul>
          )}
          {cost.schedules.map((s) => (
            <p key={s.deploymentId} className="text-[13px] text-muted">
              Schedule <code className="font-mono">{s.cronExpression}</code> runs about {s.runsPerMonth.toLocaleString()} times in 30 days:{' '}
              <span className="font-medium text-ink tabular-nums">{fmtTokens(s.tokensPerMonth)} tokens</span>
              {money(s.tokensPerMonth, cost.costPerMillion)}.
            </p>
          ))}
        </>
      )}
      {!cost.costPerMillion && <p className="text-[12px] text-faint">Set TOKEN_COST_PER_MILLION in server/.env to see amounts in dollars.</p>}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveLimit();
        }}
      >
        <div className="w-56">
          <Label htmlFor="max-tokens" hint="The run stops before its next block once it has used this many tokens. Protects against runaway loops.">
            Token limit per run
          </Label>
          <Input id="max-tokens" type="number" min={100} placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <Button type="submit" loading={saving}>
          Save limit
        </Button>
      </form>
    </div>
  );
}

/** Pipeline-level setting: which pipeline runs when this one fails. */
function OnFailure({ pipelineId }: { pipelineId: string }) {
  const [pipelines, setPipelines] = useState<{ id: string; name: string; errorPipelineId: string | null }[] | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ pipelines: { id: string; name: string; errorPipelineId: string | null }[] }>('/api/pipelines').then((r) => setPipelines(r.pipelines)).catch(() => setPipelines([]));
  }, [pipelineId]);
  if (!pipelines) return null;
  const current = pipelines.find((p) => p.id === pipelineId)?.errorPipelineId ?? '';
  const save = async (errorPipelineId: string) => {
    setSaving(true);
    try {
      await api(`/api/pipelines/${pipelineId}`, { method: 'PUT', json: { errorPipelineId: errorPipelineId || null } });
      setPipelines((ps) => ps!.map((p) => (p.id === pipelineId ? { ...p, errorPipelineId: errorPipelineId || null } : p)));
      toast.success(errorPipelineId ? 'Error workflow set' : 'Error workflow removed');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        When a run of this pipeline fails, start another pipeline. Its <code className="font-mono">{'{{input.failedRun}}'}</code> holds{' '}
        <code className="font-mono">runId</code>, <code className="font-mono">pipelineName</code>, <code className="font-mono">error</code> and <code className="font-mono">failedNodeId</code>, so it can alert you on Slack or by email.
      </p>
      <div className="w-72">
        <Label htmlFor="error-pipeline">Error workflow</Label>
        <Select id="error-pipeline" value={current} disabled={saving} onChange={(e) => save(e.target.value)}>
          <option value="">None</option>
          {pipelines.filter((p) => p.id !== pipelineId).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </div>
    </div>
  );
}

export function DeployModal({ open, onOpenChange, pipelineId }: { open: boolean; onOpenChange: (o: boolean) => void; pipelineId: string }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [timeout, setTimeoutSecs] = useState(30);
  const [creating, setCreating] = useState(false);
  const [formFields, setFormFields] = useState('Name, Email, Message');
  const [formFile, setFormFile] = useState(false);
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
          <Tabs.Trigger value="form" className={tab}>Form</Tabs.Trigger>
          <Tabs.Trigger value="failure" className={tab}>On failure</Tabs.Trigger>
          <Tabs.Trigger value="cost" className={tab}>Cost</Tabs.Trigger>
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

        <Tabs.Content value="form" className="space-y-4 focus:outline-none">
          <p className="text-[13px] text-muted">A public web form: each submission runs the pipeline with the answers as <code className="font-mono">{'{{input}}'}</code>, e.g. <code className="font-mono">{'{{input.Email}}'}</code>.</p>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create({ type: 'form', formFields, formFile });
            }}
          >
            <div>
              <Label htmlFor="form-fields" hint="Comma-separated labels. Fields named Message, Comment or Details get a large text box.">Fields</Label>
              <Input id="form-fields" value={formFields} onChange={(e) => setFormFields(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={formFile} onChange={(e) => setFormFile(e.target.checked)} />
              Also accept a text file upload (available as <code className="font-mono">{'{{input.file.text}}'}</code>)
            </label>
            <Button type="submit" variant="primary" loading={creating} disabled={!formFields.trim()}>
              Create form
            </Button>
          </form>
          {list('form').map((d) => <DeploymentCard key={d.id} d={d} onChange={load} />)}
        </Tabs.Content>

        <Tabs.Content value="failure" className="focus:outline-none">
          <OnFailure pipelineId={pipelineId} />
        </Tabs.Content>

        <Tabs.Content value="cost" className="focus:outline-none">
          <CostTab pipelineId={pipelineId} />
        </Tabs.Content>
      </Tabs.Root>
    </Modal>
  );
}
