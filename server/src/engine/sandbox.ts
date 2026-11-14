import ivm from 'isolated-vm';

const MEMORY_LIMIT_MB = 32;
let isolate: ivm.Isolate | null = null;

/**
 * Evaluates a user JS expression with `input` bound to a JSON copy of the context.
 * Runs in a separate V8 isolate (own heap, 32 MB cap, CPU timeout) with a fresh context per call:
 * no `process`, `require` or host objects exist in there, and only a JSON string crosses the boundary.
 * Evaluation is synchronous, so one shared isolate never runs two tenants' code at once.
 */
export function evalExpression(expression: string, input: unknown, timeoutMs = 500): unknown {
  if (!isolate || isolate.isDisposed) isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  const context = isolate.createContextSync();
  try {
    context.global.setSync('__in', JSON.stringify(input ?? null));
    const code = `"use strict"; JSON.stringify((function (input) { return (${expression}\n); })(JSON.parse(__in)))`;
    const out = context.evalSync(code, { timeout: timeoutMs });
    return out === undefined ? null : JSON.parse(out);
  } catch (err) {
    // A memory-limit breach disposes the isolate; the next call builds a new one.
    if (isolate.isDisposed) throw new Error(`Expression used more than ${MEMORY_LIMIT_MB} MB of memory`);
    throw err;
  } finally {
    if (!isolate.isDisposed) context.release();
  }
}
