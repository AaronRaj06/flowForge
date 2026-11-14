import type { Context, EdgeDef, Graph, NodeDef, RunEventPayload } from './types.ts';
import { topoSort } from './dag.ts';
import { resolveConfig } from './template.ts';
import { ApprovalPending, AuthError, InvalidGraphError, NodeExecutionError } from './errors.ts';
import { handlers } from './nodes/index.ts';

export type RunOptions = {
  userId?: string;
  signal?: AbortSignal;
  /** Called on every node status change; the worker persists these to Postgres. */
  onEvent?: (e: RunEventPayload) => Promise<void> | void;
  /** Stop before the next block once this many tokens are used. */
  maxTokens?: number | null;
  /** Continue a paused run: its saved context, and the status each block already reached. */
  resume?: { context: Context; statuses: Record<string, string> };
  /** Nesting level when an agent runs a pipeline as a tool. */
  depth?: number;
};

export type RunResult = { context: Context; tokensUsed: number };

const MAX_RETRIES = 5;

/**
 * Executes a pipeline in topological order. Conditional nodes kill the edges of
 * the branch not taken; a node whose incoming edges are all dead is skipped,
 * and its own outgoing edges die with it. A loop node runs its body (everything
 * downstream of it, up to a merge node) once per item.
 */
export async function runPipeline(graph: Graph, input: unknown, opts: RunOptions = {}): Promise<RunResult> {
  const state: RunState = { tokensUsed: 0, nodeTokens: new Map() };
  const context: Context = opts.resume?.context ?? { input };
  try {
    await runGraph(graph, context, opts, state, true);
  } catch (err) {
    // Tokens spent before the failure still count toward the budget.
    if (err && typeof err === 'object') (err as { tokensUsed?: number }).tokensUsed = state.tokensUsed;
    if (err instanceof ApprovalPending) err.context = context;
    throw err;
  }
  return { context, tokensUsed: state.tokensUsed };
}

/** The nodes a loop repeats: reachable from it, stopping before any merge node. */
export function loopBody(graph: Graph, loopId: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const body = new Set<string>();
  const queue = graph.edges.filter((e) => e.source === loopId).map((e) => e.target);
  while (queue.length) {
    const id = queue.shift()!;
    const n = byId.get(id)!;
    if (body.has(id) || n.type === 'merge') continue;
    if (n.type === 'loop') throw new InvalidGraphError(`Loops inside loops aren't supported yet (${id} is inside ${loopId})`);
    if (n.type === 'approval') throw new InvalidGraphError(`Approval blocks can't be inside a loop (${id} is inside ${loopId})`);
    body.add(id);
    queue.push(...graph.edges.filter((e) => e.source === id).map((e) => e.target));
  }
  for (const e of graph.edges) {
    if (body.has(e.target) && e.source !== loopId && !body.has(e.source)) {
      throw new InvalidGraphError(`Block ${e.target} is inside loop ${loopId} but is also connected from ${e.source} outside it; reference outside values with {{placeholders}} instead`);
    }
  }
  return body;
}

type RunState = { tokensUsed: number; nodeTokens: Map<string, number> };

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

async function runGraph(graph: Graph, context: Context, opts: RunOptions, state: RunState, top: boolean) {
  const order = topoSort(graph);
  for (const n of order) {
    if (!handlers[n.type]) throw new InvalidGraphError(`Unknown node type "${n.type}" on ${n.id}`);
  }
  const emit = async (e: RunEventPayload) => opts.onEvent?.(e);
  const deadEdges = new Set<number>();
  const done = new Set<string>(); // loop bodies, already run by their loop
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const alias = (n: NodeDef) => n.name || n.id;
  const store = (n: NodeDef, value: Record<string, unknown>) => {
    context[n.id] = value;
    if (n.name) context[n.name] = value;
  };

  if (top && !opts.resume) for (const n of order) await emit({ nodeId: n.id, status: 'pending' });
  const before = (top && opts.resume?.statuses) || {};
  /** Conditionals and approvals kill the edges of the branch not taken. */
  const prune = (node: NodeDef, output: unknown, outgoing: (readonly [EdgeDef, number])[]) => {
    if (node.type !== 'conditional' && node.type !== 'approval') return;
    const taken = (node.type === 'approval' ? (output as { approved?: boolean })?.approved : output) ? 'true' : 'false';
    outgoing.filter(([e]) => (e.sourceHandle ?? 'true') !== taken).forEach(([, i]) => deadEdges.add(i));
  };

  for (const node of order) {
    if (done.has(node.id)) continue;
    opts.signal?.throwIfAborted();
    const incoming = graph.edges.map((e, i) => [e, i] as const).filter(([e]) => e.target === node.id);
    const outgoing = graph.edges.map((e, i) => [e, i] as const).filter(([e]) => e.source === node.id);

    // Resuming: blocks that finished before the pause keep their results.
    if (before[node.id] === 'skipped') {
      outgoing.forEach(([, i]) => deadEdges.add(i));
      continue;
    }
    if (context[node.id] && (before[node.id] === 'success' || before[node.id] === 'error')) {
      prune(node, context[node.id].output, outgoing);
      continue;
    }

    if (incoming.length && incoming.every(([, i]) => deadEdges.has(i))) {
      outgoing.forEach(([, i]) => deadEdges.add(i));
      await emit({ nodeId: node.id, status: 'skipped' });
      continue;
    }

    // Outputs of live predecessors, keyed by name; merge nodes combine these.
    const inputs: Record<string, unknown> = {};
    for (const [e, i] of incoming) {
      const src = byId.get(e.source)!;
      if (!deadEdges.has(i) && context[src.id]) inputs[alias(src)] = context[src.id].output;
    }

    const tokensOf = () => state.nodeTokens.get(node.id) || undefined;
    if (opts.maxTokens && state.tokensUsed >= opts.maxTokens) {
      const err = new Error(`Token limit reached: this run used ${state.tokensUsed.toLocaleString()} of its ${opts.maxTokens.toLocaleString()}-token limit`);
      await emit({ nodeId: node.id, status: 'error', error: err.message });
      throw new NodeExecutionError(node.id, err, node.name);
    }

    const handler = handlers[node.type];
    const cfg = node.config ?? {};
    const attempts = 1 + Math.min(Math.max(Math.floor(Number(cfg.retries) || 0), 0), MAX_RETRIES);
    const retryDelay = Math.min(Math.max(Number(cfg.retryDelayMs ?? 1000), 0), 30_000);
    const startedAt = new Date();
    await emit({ nodeId: node.id, status: 'running', startedAt });

    let output: unknown;
    let failure: Error | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const config = resolveConfig(cfg, context, handler.rawFields);
        output = await handler.run(config, {
          nodeId: node.id,
          context,
          inputs,
          userId: opts.userId,
          signal: opts.signal,
          depth: opts.depth ?? 0,
          addTokens: (t) => {
            state.tokensUsed += t;
            state.nodeTokens.set(node.id, (state.nodeTokens.get(node.id) ?? 0) + t);
          },
        });
        failure = undefined;
        break;
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        // Auth problems, cancellations and approval pauses won't change on retry.
        if (failure instanceof AuthError || failure instanceof ApprovalPending || opts.signal?.aborted || attempt === attempts) break;
        await wait(retryDelay * 2 ** (attempt - 1), opts.signal);
      }
    }

    if (failure instanceof ApprovalPending) {
      await emit({ nodeId: node.id, status: 'waiting', startedAt });
      throw failure;
    }
    if (failure) {
      const status = failure instanceof AuthError ? 'auth_error' : 'error';
      const error = attempts > 1 ? `${failure.message} (after ${attempts} attempts)` : failure.message;
      await emit({ nodeId: node.id, status, error, tokens: tokensOf(), startedAt, endedAt: new Date() });
      if (!cfg.continueOnFail || opts.signal?.aborted) throw new NodeExecutionError(node.id, failure, node.name);
      store(node, { output: null, error }); // downstream can branch on {{name.error}}
      continue;
    }

    if (node.type === 'loop') {
      const items = output as unknown[];
      const body = loopBody(graph, node.id);
      const sub: Graph = {
        nodes: graph.nodes.filter((n) => body.has(n.id)),
        edges: graph.edges.filter((e) => body.has(e.source) && body.has(e.target)),
      };
      const results = new Map<string, unknown[]>([...body].map((id) => [id, []]));
      for (let index = 0; index < items.length; index++) {
        const iter: Context = { ...context, item: items[index], index };
        await runGraph(sub, iter, opts, state, false);
        for (const id of body) results.get(id)!.push(iter[id]?.output ?? null);
      }
      for (const n of sub.nodes) {
        const out = results.get(n.id)!;
        store(n, { output: out });
        done.add(n.id);
        await emit({ nodeId: n.id, status: items.length ? 'success' : 'skipped', output: out, tokens: state.nodeTokens.get(n.id) || undefined, endedAt: new Date() });
      }
      output = { count: items.length, items };
    }

    store(node, { output });
    prune(node, output, outgoing);
    await emit({ nodeId: node.id, status: 'success', output, tokens: tokensOf(), startedAt, endedAt: new Date() });
  }
}
