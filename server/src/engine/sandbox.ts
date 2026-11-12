import vm from 'node:vm';

/**
 * Evaluates a user JS expression with `input` bound to a JSON copy of the context.
 * The sandbox has a null-prototype global, no eval/Function, and only JSON crosses
 * the boundary, so no host-realm object (and no route to `process`) is reachable.
 * shortcut: node:vm is not a hard security boundary; move to isolated-vm or a separate process for untrusted multi-tenant use.
 */
export function evalExpression(expression: string, input: unknown, timeoutMs = 500): unknown {
  const sandbox = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  sandbox.__in = JSON.stringify(input ?? null);
  const code = `"use strict"; JSON.stringify((function (input) { return (${expression}\n); })(JSON.parse(__in)))`;
  const out = vm.runInContext(code, sandbox, { timeout: timeoutMs });
  return out === undefined ? null : JSON.parse(out);
}
