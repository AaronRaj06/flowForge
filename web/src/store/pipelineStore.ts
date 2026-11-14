import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type XYPosition,
} from '@xyflow/react';
import { META } from '../lib/nodeTypes';

export type NodeStatus = 'idle' | 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'auth_error' | 'waiting';

export type NodeData = {
  name: string;
  config: Record<string, any>;
  status: NodeStatus;
  output?: unknown;
  error?: string;
  /** LLM tokens used in the last run. */
  tokens?: number;
};

export type PipelineNode = Node<NodeData>;

export type PipelineJSON = {
  nodes: { id: string; type: string; name: string; config: Record<string, any>; position: XYPosition }[];
  edges: { id: string; source: string; target: string; sourceHandle: string | null }[];
};

type RunState = { runId: string | null; status: 'idle' | 'running' | 'SUCCESS' | 'ERROR' | 'CANCELLED' | 'WAITING'; error?: string; output?: unknown; waiting?: { nodeId: string; request: string } };

type State = {
  pipelineId: string | null;
  name: string;
  nodes: PipelineNode[];
  edges: Edge[];
  selectedId: string | null;
  dirty: boolean;
  run: RunState;

  onNodesChange: (c: NodeChange<PipelineNode>[]) => void;
  onEdgesChange: (c: EdgeChange[]) => void;
  onConnect: (c: Connection) => void;
  addNode: (type: string, position: XYPosition) => string;
  updateNodeConfig: (id: string, config: Record<string, any>) => void;
  renameNode: (id: string, name: string) => void;
  select: (id: string | null) => void;
  setName: (name: string) => void;
  getPipelineJSON: () => PipelineJSON;
  load: (p: { id: string | null; name: string; graph: Partial<PipelineJSON> }) => void;
  markSaved: (id: string) => void;
  setNodeStatus: (id: string, patch: Partial<Pick<NodeData, 'status' | 'output' | 'error' | 'tokens'>>) => void;
  startRun: (runId: string) => void;
  finishRun: (r: Omit<RunState, 'runId'>) => void;
  /** After an approval decision: stream again, keeping the statuses already shown. */
  resumeRun: () => void;
};

function uniqueName(prefix: string, nodes: PipelineNode[]) {
  const taken = new Set(nodes.map((n) => n.data.name));
  let i = 1;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

const clearStatus = (nodes: PipelineNode[]) =>
  nodes.map((n) => ({ ...n, data: { ...n.data, status: 'idle' as const, output: undefined, error: undefined, tokens: undefined } }));

export const usePipeline = create<State>((set, get) => ({
  pipelineId: null,
  name: 'Untitled pipeline',
  nodes: [],
  edges: [],
  selectedId: null,
  dirty: false,
  run: { runId: null, status: 'idle' },

  onNodesChange: (changes) => {
    const structural = changes.some((c) => c.type !== 'select' && c.type !== 'dimensions');
    const removed = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes),
      dirty: s.dirty || structural,
      selectedId: removed.includes(s.selectedId ?? '') ? null : s.selectedId,
    }));
  },
  onEdgesChange: (changes) =>
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges), dirty: s.dirty || changes.some((c) => c.type !== 'select') })),
  onConnect: (c) => {
    if (c.source === c.target) return;
    set((s) => ({ edges: addEdge({ ...c, id: crypto.randomUUID() }, s.edges), dirty: true }));
  },

  addNode: (type, position) => {
    const meta = META[type];
    const id = crypto.randomUUID();
    set((s) => ({
      nodes: [
        ...s.nodes.map((n) => ({ ...n, selected: false })),
        { id, type, position, selected: true, data: { name: uniqueName(meta.prefix, s.nodes), config: structuredClone(meta.defaultConfig), status: 'idle' } },
      ],
      selectedId: id,
      dirty: true,
    }));
    return id;
  },
  updateNodeConfig: (id, config) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...config } } } : n)),
      dirty: true,
    })),
  renameNode: (id, name) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, name } } : n)), dirty: true })),
  select: (id) => set({ selectedId: id }),
  setName: (name) => set({ name, dirty: true }),

  getPipelineJSON: () => {
    const { nodes, edges } = get();
    return {
      nodes: nodes.map((n) => ({ id: n.id, type: n.type!, name: n.data.name, config: n.data.config, position: n.position })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
    };
  },

  load: ({ id, name, graph }) =>
    set({
      pipelineId: id,
      name,
      nodes: (graph.nodes ?? []).map((n, i) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: 80 + i * 280, y: 160 },
        data: { name: n.name || n.id, config: n.config ?? {}, status: 'idle' },
      })),
      edges: (graph.edges ?? []).map((e) => ({ id: e.id ?? crypto.randomUUID(), source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined })),
      selectedId: null,
      dirty: false,
      run: { runId: null, status: 'idle' },
    }),
  markSaved: (id) => set({ pipelineId: id, dirty: false }),

  setNodeStatus: (id, patch) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) })),
  startRun: (runId) => set((s) => ({ run: { runId, status: 'running' }, nodes: clearStatus(s.nodes) })),
  finishRun: (r) => set((s) => ({ run: { ...r, runId: s.run.runId } })),
  resumeRun: () => set((s) => ({ run: { runId: s.run.runId, status: 'running' } })),
}));
