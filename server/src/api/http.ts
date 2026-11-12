import type { Request, Response, NextFunction } from 'express';
import { topoSort } from '../engine/dag.ts';
import type { Graph } from '../engine/types.ts';
import { handlers } from '../engine/nodes/index.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.name === 'MulterError') return void res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
}

/** Validates graph shape at the trust boundary before it is stored or run. */
export function parseGraph(raw: unknown): Graph {
  const g = raw as Graph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new HttpError(400, 'graph must have nodes and edges arrays');
  if (g.nodes.length > 200) throw new HttpError(400, 'Pipelines are limited to 200 nodes');
  for (const n of g.nodes) {
    if (typeof n?.id !== 'string' || typeof n.type !== 'string') throw new HttpError(400, 'Every node needs a string id and type');
    if (!handlers[n.type]) throw new HttpError(400, `Unknown node type "${n.type}"`);
    if (n.config != null && typeof n.config !== 'object') throw new HttpError(400, `Node ${n.id} config must be an object`);
  }
  for (const e of g.edges) {
    if (typeof e?.source !== 'string' || typeof e.target !== 'string') throw new HttpError(400, 'Every edge needs a source and target');
  }
  try {
    topoSort(g);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return {
    nodes: g.nodes.map(({ id, type, name, config, position }) => ({ id, type, name, config: config ?? {}, position })),
    edges: g.edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, sourceHandle: sourceHandle ?? null })),
  };
}
