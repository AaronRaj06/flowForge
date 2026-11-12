import type { Context, Graph, RunEventPayload } from './types.ts';
import { topoSort } from './dag.ts';
import { resolveConfig } from './template.ts';
import { AuthError, InvalidGraphError, NodeExecutionError } from './errors.ts';
import { handlers } from './nodes/index.ts';

export type RunOptions = {
  userId?: string;
  signal?: AbortSignal;
  /** Called on every node status change; the worker persists these to Postgres. */
  onEvent?: (e: RunEventPayload) => Promise<void> | void;
};

export type RunResult = { context: Context; tokensUsed: number };

/**
 * Executes a pipeline in topological order. Conditional nodes kill the edges of
 * the branch not taken; a node whose incoming edges are all dead is skipped,
 * and its own outgoing edges die with it.
 */
export async function runPipeline(graph: Graph, input: unknown, opts: RunOptions = {}): Promise<RunResult> {
  const order = topoSort(graph);
  for (const n of order) {
    if (!handlers[n.type]) throw new InvalidGraphError(`Unknown node type "${n.type}" on ${n.id}`);
  }

  const emit = async (e: RunEventPayload) => opts.onEvent?.(e);
  const context: Context = { input };
  const deadEdges = new Set<number>();
  let tokensUsed = 0;

  for (const n of order) await emit({ nodeId: n.id, status: 'pending' });

  for (const node of order) {
    opts.signal?.throwIfAborted();
    const incoming = graph.edges.map((e, i) => [e, i] as const).filter(([e]) => e.target === node.id);
    const outgoing = graph.edges.map((e, i) => [e, i] as const).filter(([e]) => e.source === node.id);

    if (incoming.length && incoming.every(([, i]) => deadEdges.has(i))) {
      outgoing.forEach(([, i]) => deadEdges.add(i));
      await emit({ nodeId: node.id, status: 'skipped' });
      continue;
    }

    const handler = handlers[node.type];
    const startedAt = new Date();
    await emit({ nodeId: node.id, status: 'running', startedAt });
    try {
      const config = resolveConfig(node.config ?? {}, context, handler.rawFields);
      const output = await handler.run(config, {
        nodeId: node.id,
        context,
        userId: opts.userId,
        signal: opts.signal,
        addTokens: (t) => (tokensUsed += t),
      });
      context[node.id] = { output };
      if (node.name) context[node.name] = context[node.id];

      if (node.type === 'conditional') {
        const taken = output ? 'true' : 'false';
        outgoing.filter(([e]) => (e.sourceHandle ?? 'true') !== taken).forEach(([, i]) => deadEdges.add(i));
      }
      await emit({ nodeId: node.id, status: 'success', output, startedAt, endedAt: new Date() });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await emit({
        nodeId: node.id,
        status: e instanceof AuthError ? 'auth_error' : 'error',
        error: e.message,
        startedAt,
        endedAt: new Date(),
      });
      throw new NodeExecutionError(node.id, e);
    }
  }

  return { context, tokensUsed };
}
