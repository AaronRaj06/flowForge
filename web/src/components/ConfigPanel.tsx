import { useEffect, useState } from 'react';
import { Trash2, PlugZap, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useReactFlow } from '@xyflow/react';
import { Link } from 'react-router-dom';
import { usePipeline } from '../store/pipelineStore';
import { META, type Field } from '../lib/nodeTypes';
import { useIntegrations } from '../hooks/useIntegrations';
import { Button, Input, Label, Select, Textarea } from './ui';

const PROVIDER_LABEL: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', sheets: 'Google Sheets' };

/** Checkbox list for an agent's tools: built-ins plus the user's saved pipelines. Stored as ['http', 'kb', 'pipeline:<id>']. */
function ToolsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const ownId = usePipeline((s) => s.pipelineId);
  useEffect(() => {
    api<{ pipelines: { id: string; name: string }[] }>('/api/pipelines').then((r) => setPipelines(r.pipelines)).catch(() => {});
  }, []);
  const options = [
    { value: 'http', label: 'Web requests (HTTP)' },
    { value: 'kb', label: 'Search my knowledge base' },
    ...pipelines.filter((p) => p.id !== ownId).map((p) => ({ value: `pipeline:${p.id}`, label: `Run pipeline “${p.name}”` })),
  ];
  return (
    <div className="space-y-1.5">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Picks one of the user's saved credentials of a type; secrets never reach the browser. */
function CredentialInput({ id, type, value, onChange }: { id: string; type: string; value: string; onChange: (v: string) => void }) {
  const [creds, setCreds] = useState<{ id: string; name: string; type: string }[] | null>(null);
  useEffect(() => {
    api<{ credentials: { id: string; name: string; type: string }[] }>('/api/credentials').then((r) => setCreds(r.credentials.filter((c) => c.type === type))).catch(() => setCreds([]));
  }, [type]);
  if (creds && !creds.length) {
    return <p className="text-[12px] text-muted">No saved credential yet. <Link to="/credentials" className="font-medium text-ink underline">Add one on the Credentials page</Link>.</p>;
  }
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>
      {(creds ?? []).map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </Select>
  );
}

function FieldInput({ field, value, onChange }: { field: Field; value: any; onChange: (v: any) => void }) {
  const id = `f-${field.key}`;
  const [jsonError, setJsonError] = useState<string | null>(null);
  return (
    <div>
      <Label htmlFor={id} hint={field.hint}>
        {field.label}
      </Label>
      {field.kind === 'credential' ? (
        <CredentialInput id={id} type={field.credentialType!} value={value} onChange={onChange} />
      ) : field.kind === 'tools' ? (
        <ToolsInput value={Array.isArray(value) ? value : []} onChange={onChange} />
      ) : field.kind === 'select' ? (
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {field.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : field.kind === 'number' ? (
        <Input id={id} type="number" min={0} value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />
      ) : field.kind === 'text' ? (
        <Input id={id} value={value ?? ''} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <>
          <Textarea
            id={id}
            mono={field.kind !== 'textarea'}
            value={value ?? ''}
            placeholder={field.placeholder}
            onChange={(e) => {
              onChange(e.target.value);
              if (field.kind === 'json') {
                try {
                  if (e.target.value.trim()) JSON.parse(e.target.value);
                  setJsonError(null);
                } catch {
                  setJsonError('Not valid JSON yet');
                }
              }
            }}
          />
          {jsonError && <p className="mt-1 text-[12px] text-st-error">{jsonError}</p>}
        </>
      )}
    </div>
  );
}

function IntegrationBanner({ provider, needsReconnect }: { provider: string; needsReconnect: boolean }) {
  const { status, connect } = useIntegrations();
  const s = status(provider);
  const label = PROVIDER_LABEL[provider];
  if (s && !s.configured) {
    return (
      <div className="rounded-md border border-line bg-sunken p-3 text-[12px] text-muted">
        {label} isn’t set up on this server yet. Add its OAuth client ID and secret to <code className="font-mono">server/.env</code>.
      </div>
    );
  }
  if (s?.connected && !needsReconnect) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-st-success">
        <CheckCircle2 size={14} /> {label} connected
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line p-3">
      {needsReconnect && (
        <p className="mb-2 flex items-center gap-1.5 text-[12px] text-st-error">
          <AlertTriangle size={14} /> {label} access was revoked or expired.
        </p>
      )}
      <Button variant="primary" onClick={() => connect(provider)} className="w-full">
        <PlugZap size={14} /> {needsReconnect ? 'Reconnect' : 'Connect'} {label}
      </Button>
    </div>
  );
}

type Fix = { explanation: string; changes: Record<string, unknown> };

/** Asks the AI why a block failed and offers its config change as a one-click Apply. */
function FixWithAI({ type, name, config, error, onApply }: { type: string; name: string; config: Record<string, any>; error: string; onApply: (c: Record<string, unknown>) => void }) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    try {
      setFix(await api<Fix>('/api/ai/fix', { method: 'POST', json: { node: { type, name, config }, error } }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!fix) {
    return (
      <Button onClick={ask} loading={busy} className="w-full">
        <Sparkles size={14} /> Fix with AI
      </Button>
    );
  }
  const keys = Object.keys(fix.changes);
  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <p className="text-[13px]">{fix.explanation || 'No explanation given.'}</p>
      {keys.length > 0 && (
        <pre className="max-h-40 overflow-auto rounded bg-sunken p-2 font-mono text-[11.5px] whitespace-pre-wrap break-words">
          {keys.map((k) => `${k}: ${typeof fix.changes[k] === 'string' ? fix.changes[k] : JSON.stringify(fix.changes[k])}`).join('\n')}
        </pre>
      )}
      <div className="flex gap-2">
        {keys.length > 0 && (
          <Button size="sm" variant="primary" onClick={() => (onApply(fix.changes), setFix(null), toast.success('Fix applied. Run again to check it.'))}>
            Apply
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setFix(null)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function ConfigPanel() {
  const node = usePipeline((s) => s.nodes.find((n) => n.id === s.selectedId));
  const { updateNodeConfig, renameNode } = usePipeline();
  const { deleteElements } = useReactFlow();

  if (!node) {
    return (
      <div className="p-4 text-[13px] text-muted">
        <p className="font-medium text-ink">No block selected</p>
        <p className="mt-1">Select a block to edit its settings. Reference earlier blocks in any text field with <code className="font-mono text-[12px] text-ink">{'{{name.output}}'}</code>, and the run input with <code className="font-mono text-[12px] text-ink">{'{{input}}'}</code>.</p>
      </div>
    );
  }

  const meta = META[node.type!];
  const nameOk = /^[A-Za-z_][\w-]*$/.test(node.data.name);
  return (
    <div className="space-y-4 p-4" key={node.id}>
      <div className="flex items-center gap-2">
        <meta.icon size={16} className="text-muted" />
        <h2 className="flex-1 text-[14px] font-semibold">{meta.label}</h2>
        <Button variant="ghost" size="sm" aria-label="Delete block" onClick={() => deleteElements({ nodes: [{ id: node.id }] })}>
          <Trash2 size={14} />
        </Button>
      </div>

      <div>
        <Label htmlFor="node-name" hint={<>Use <code className="font-mono">{`{{${node.data.name}.output}}`}</code> in later blocks.</>}>
          Name
        </Label>
        <Input id="node-name" value={node.data.name} onChange={(e) => renameNode(node.id, e.target.value.replace(/\s/g, '_'))} className="font-mono text-[12px]" />
        {!nameOk && <p className="mt-1 text-[12px] text-st-error">Use letters, numbers, - and _ only.</p>}
      </div>

      {meta.integration && <IntegrationBanner provider={meta.integration} needsReconnect={node.data.status === 'auth_error'} />}

      {meta.fields.map((f) => (
        <FieldInput key={f.key} field={f} value={node.data.config[f.key]} onChange={(v) => updateNodeConfig(node.id, { [f.key]: v })} />
      ))}

      {!meta.trigger && (
        <details className="rounded-md border border-line p-3" open={Boolean(node.data.config.retries || node.data.config.continueOnFail)}>
          <summary className="cursor-pointer text-[13px] font-medium">On error</summary>
          <div className="mt-3 space-y-3">
            <FieldInput
              field={{ key: 'retries', label: 'Retries', kind: 'number', hint: 'Try again up to 5 times, waiting 1s, 2s, 4s… between attempts. Careful with blocks that send messages.' }}
              value={node.data.config.retries ?? 0}
              onChange={(v) => updateNodeConfig(node.id, { retries: Math.min(Math.max(Number(v) || 0, 0), 5) })}
            />
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={Boolean(node.data.config.continueOnFail)} onChange={(e) => updateNodeConfig(node.id, { continueOnFail: e.target.checked })} />
              <span>
                Continue on fail
                <span className="block text-[12px] text-muted">The run keeps going; later blocks can check <code className="font-mono">{`{{${node.data.name}.error}}`}</code>.</span>
              </span>
            </label>
          </div>
        </details>
      )}

      {(node.data.output !== undefined || node.data.error) && (
        <div>
          <Label>{node.data.error ? 'Error' : 'Last output'}</Label>
          <pre className={`max-h-64 overflow-auto rounded-md bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words ${node.data.error ? 'text-st-error' : ''}`}>
            {node.data.error ?? (typeof node.data.output === 'string' ? node.data.output : JSON.stringify(node.data.output, null, 2))}
          </pre>
          {node.data.error && node.data.status !== 'auth_error' && (
            <div className="mt-2">
              <FixWithAI type={node.type!} name={node.data.name} config={node.data.config} error={node.data.error} onApply={(c) => updateNodeConfig(node.id, c)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
