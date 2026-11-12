import type { Graph, NodeDef } from './types.ts';
import { CyclicDependencyError, InvalidGraphError } from './errors.ts';

/** Kahn's algorithm. Throws CyclicDependencyError if the graph is not a DAG. */
export function topoSort(graph: Graph): NodeDef[] {
  const byId = new Map<string, NodeDef>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) throw new InvalidGraphError(`Duplicate node id ${n.id}`);
    byId.set(n.id, n);
  }

  const indegree = new Map<string, number>([...byId.keys()].map((id) => [id, 0]));
  const out = new Map<string, string[]>([...byId.keys()].map((id) => [id, []]));
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      throw new InvalidGraphError(`Edge ${e.source} → ${e.target} references a missing node`);
    }
    out.get(e.source)!.push(e.target);
    indegree.set(e.target, indegree.get(e.target)! + 1);
  }

  // Seed in declaration order so the result is deterministic.
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const sorted: NodeDef[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sorted.push(byId.get(id)!);
    for (const next of out.get(id)!) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (sorted.length !== graph.nodes.length) {
    throw new CyclicDependencyError([...indegree].filter(([, d]) => d > 0).map(([id]) => id));
  }
  return sorted;
}
