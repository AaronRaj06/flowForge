import { randomUUID } from 'node:crypto';
import type { Graph } from '../engine/types.ts';

/**
 * Deep-copies a graph with a fresh UUID for every node. Edge endpoints and any
 * {{oldId.…}} placeholders inside configs are rewritten to the new ids, so the
 * copy behaves exactly like the original. Node names are kept.
 */
export function cloneGraph(graph: Graph, newId: () => string = randomUUID): Graph {
  const ids = new Map(graph.nodes.map((n) => [n.id, newId()]));
  if (new Set(ids.values()).size !== ids.size) throw new Error('cloneGraph: id generator returned duplicates');

  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\{\{\s*([\w-]+)((?:\.[\w-]+)*)\s*\}\}/g, (m, root, rest) => (ids.has(root) ? `{{${ids.get(root)}${rest}}}` : m));
    }
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };

  return {
    nodes: graph.nodes.map((n) => ({ ...structuredClone(n), id: ids.get(n.id)!, config: rewrite(structuredClone(n.config ?? {})) as Record<string, any> })),
    edges: graph.edges.map((e) => {
      if (!ids.has(e.source) || !ids.has(e.target)) throw new Error(`cloneGraph: edge ${e.source} → ${e.target} points at a missing node`);
      return { ...e, id: newId(), source: ids.get(e.source)!, target: ids.get(e.target)! };
    }),
  };
}
