import { useState } from 'react';
import { Trash2, PlugZap, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useReactFlow } from '@xyflow/react';
import { usePipeline } from '../store/pipelineStore';
import { META, type Field } from '../lib/nodeTypes';
import { useIntegrations } from '../hooks/useIntegrations';
import { Button, Input, Label, Select, Textarea } from './ui';

const PROVIDER_LABEL: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', sheets: 'Google Sheets' };

function FieldInput({ field, value, onChange }: { field: Field; value: any; onChange: (v: any) => void }) {
  const id = `f-${field.key}`;
  const [jsonError, setJsonError] = useState<string | null>(null);
  return (
    <div>
      <Label htmlFor={id} hint={field.hint}>
        {field.label}
      </Label>
      {field.kind === 'select' ? (
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

      {(node.data.output !== undefined || node.data.error) && (
        <div>
          <Label>{node.data.error ? 'Error' : 'Last output'}</Label>
          <pre className={`max-h-64 overflow-auto rounded-md bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words ${node.data.error ? 'text-st-error' : ''}`}>
            {node.data.error ?? (typeof node.data.output === 'string' ? node.data.output : JSON.stringify(node.data.output, null, 2))}
          </pre>
        </div>
      )}
    </div>
  );
}
