import type { Context } from './types.ts';
import { MissingVariableError } from './errors.ts';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Look up a dotted path like "n1.output.title" in the context. */
export function lookup(context: Context, path: string): unknown {
  let cur: any = context;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) throw new MissingVariableError(path);
    cur = cur[key];
  }
  return cur;
}

export function resolveString(str: string, context: Context): unknown {
  // A field that is exactly one placeholder keeps the value's type (e.g. an array for Sheets rows).
  const whole = str.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
  if (whole) return lookup(context, whole[1]);
  return str.replace(PLACEHOLDER, (_, path) => {
    const v = lookup(context, path);
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Deep-resolve every string in a config object, skipping `rawFields`. */
export function resolveConfig(config: Record<string, any>, context: Context, rawFields: string[] = []) {
  const walk = (v: any): any => {
    if (typeof v === 'string') return resolveString(v, context);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k, rawFields.includes(k) ? v : walk(v)]),
  );
}

/** All placeholder keys used anywhere in a config (for template variables). */
export function findPlaceholders(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) found.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => findPlaceholders(v, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => findPlaceholders(v, found));
  return found;
}
