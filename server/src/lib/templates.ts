import type { Graph } from '../engine/types.ts';
import { findPlaceholders } from '../engine/template.ts';

const SENSITIVE_KEY = /^(x-)?(api[_-]?key|(access|refresh|auth|bearer|id)?[_-]?token|(client[_-]?)?secret|password|passwd|authorization|cookie|credentials?|private[_-]?key)$/i;

/** Drops secret-looking config fields and headers before a graph is shared. */
export function stripSecrets(graph: Graph): Graph {
  const clean = (v: any): any => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !SENSITIVE_KEY.test(k)).map(([k, x]) => [k, clean(x)]));
    }
    return v;
  };
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const config = clean(n.config ?? {});
      // HTTP headers are often stored as a JSON string.
      if (typeof config.headers === 'string' && config.headers.trim()) {
        try {
          config.headers = JSON.stringify(clean(JSON.parse(config.headers)), null, 2);
        } catch {
          config.headers = '';
        }
      }
      return { ...n, config };
    }),
  };
}

export type TemplateVariable = { key: string; description: string; defaultValue: string };

/** Placeholders that don't reference a node (by id or name) or the run input become variables. */
export function extractVariables(graph: Graph): TemplateVariable[] {
  const refs = new Set(['input', ...graph.nodes.flatMap((n) => [n.id, n.name].filter(Boolean) as string[])]);
  const keys = [...findPlaceholders(graph.nodes.map((n) => n.config))].filter((k) => !refs.has(k.split('.')[0]));
  return [...new Set(keys)].map((key) => ({ key, description: `Used in ${graph.nodes.filter((n) => findPlaceholders(n.config).has(key)).map((n) => n.name ?? n.type).join(', ')}`, defaultValue: '' }));
}

/** Replaces {{key}} for each template variable with the user's value. */
export function fillVariables(graph: Graph, values: Record<string, string>): Graph {
  const fill = (v: any): any => {
    if (typeof v === 'string') return v.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, config: fill(n.config) })) };
}
