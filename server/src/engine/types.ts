export type NodeDef = {
  id: string;
  type: string;
  /** Optional readable alias, so prompts can say {{summary.output}} instead of a UUID. */
  name?: string;
  config: Record<string, any>;
  position?: { x: number; y: number };
};

export type EdgeDef = {
  id?: string;
  source: string;
  target: string;
  /** For conditional nodes: "true" | "false". */
  sourceHandle?: string | null;
};

export type Graph = { nodes: NodeDef[]; edges: EdgeDef[] };

export type NodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'auth_error' | 'waiting';

export type RunEventPayload = {
  nodeId: string;
  status: NodeStatus;
  output?: unknown;
  error?: string;
  /** LLM tokens this block used (summed over loop iterations). */
  tokens?: number;
  startedAt?: Date;
  endedAt?: Date;
};

export type Context = Record<string, any>;

export type NodeContext = {
  nodeId: string;
  context: Context;
  /** Outputs of the live upstream blocks, keyed by name (or id). */
  inputs: Record<string, unknown>;
  userId?: string;
  signal?: AbortSignal;
  /** How many pipelines deep this block runs (an agent calling a pipeline adds one). */
  depth: number;
  addTokens: (n: number) => void;
};

export type NodeHandler = {
  /** Config fields that hold code and must not get {{placeholder}} substitution. */
  rawFields?: string[];
  run: (config: Record<string, any>, ctx: NodeContext) => Promise<unknown>;
};
