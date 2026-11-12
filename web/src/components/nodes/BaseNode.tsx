import { Handle, Position, type NodeProps } from '@xyflow/react';
import { META } from '../../lib/nodeTypes';
import type { PipelineNode } from '../../store/pipelineStore';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  success: 'Done',
  error: 'Failed',
  auth_error: 'Reconnect',
  skipped: 'Skipped',
};

/** Shared shell for every node type: title bar, handles, one-line config summary. */
export function BaseNode({ id, type, data, selected }: NodeProps<PipelineNode>) {
  const meta = META[type];
  const Icon = meta.icon;
  return (
    <div
      className="pipeline-node relative w-60 rounded-lg bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.05)]"
      data-status={data.status}
      data-selected={selected}
      aria-label={`${meta.label} node ${data.name}`}
    >
      {!meta.trigger && <Handle type="target" position={Position.Left} />}

      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="grid size-6 place-items-center rounded-md bg-sunken text-ink">
          <Icon size={14} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-medium">{meta.label}</div>
          <div className="truncate font-mono text-[11px] leading-tight text-faint">{data.name}</div>
        </div>
        {data.status !== 'idle' && (
          <span className="text-[11px] font-medium text-muted" data-testid={`status-${id}`}>
            {STATUS_LABEL[data.status]}
          </span>
        )}
      </div>

      <div className="px-3 py-2 text-[12px] leading-snug text-muted">
        <span className="line-clamp-2 break-words">{meta.summary(data.config)}</span>
        {data.error && <p className="mt-1 line-clamp-2 text-st-error">{data.error}</p>}
      </div>

      {meta.branches ? (
        <>
          <Handle type="source" position={Position.Right} id="true" className="handle-true" style={{ top: '38%' }} />
          <Handle type="source" position={Position.Right} id="false" className="handle-false" style={{ top: '72%' }} />
          <span className="pointer-events-none absolute top-[38%] -right-9 -translate-y-1/2 text-[10px] font-medium text-st-success">true</span>
          <span className="pointer-events-none absolute top-[72%] -right-9 -translate-y-1/2 text-[10px] font-medium text-st-error">false</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}
