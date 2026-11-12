import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort } from '../src/engine/dag.ts';
import { resolveConfig, findPlaceholders } from '../src/engine/template.ts';
import { runPipeline } from '../src/engine/runner.ts';
import { evalExpression } from '../src/engine/sandbox.ts';
import { CyclicDependencyError, MissingVariableError, NodeExecutionError } from '../src/engine/errors.ts';
import type { Graph, RunEventPayload } from '../src/engine/types.ts';

test('topoSort orders by edges and detects cycles', () => {
  const g: Graph = {
    nodes: [{ id: 'c', type: 'llm', config: {} }, { id: 'a', type: 'llm', config: {} }, { id: 'b', type: 'llm', config: {} }],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
  };
  assert.deepEqual(topoSort(g).map((n) => n.id), ['a', 'b', 'c']);
  g.edges.push({ source: 'c', target: 'a' });
  assert.throws(() => topoSort(g), CyclicDependencyError);
});

test('placeholders resolve paths, keep types for whole-field refs, and throw on missing', () => {
  const ctx = { input: 'hi', n1: { output: { rows: [1, 2] } } };
  assert.deepEqual(resolveConfig({ a: 'say {{input}}', b: '{{n1.output.rows}}', c: { d: ['{{ input }}'] } }, ctx), {
    a: 'say hi',
    b: [1, 2],
    c: { d: ['hi'] },
  });
  assert.throws(() => resolveConfig({ a: '{{nope.output}}' }, ctx), MissingVariableError);
  assert.equal(resolveConfig({ expression: '{{keep}}' }, ctx, ['expression']).expression, '{{keep}}');
  assert.deepEqual([...findPlaceholders({ x: '{{a}} {{b.c}}', y: ['{{a}}'] })], ['a', 'b.c']);
});

test('conditional skips the branch not taken, and its descendants', async () => {
  const g: Graph = {
    nodes: [
      { id: 'cond', type: 'conditional', config: { expression: 'input.input.n > 5' } },
      { id: 'big', type: 'transform', config: { expression: '"big"' } },
      { id: 'small', type: 'transform', config: { expression: '"small"' } },
      { id: 'afterSmall', type: 'transform', config: { expression: '1' } },
      { id: 'join', type: 'transform', config: { expression: 'input.big ? input.big.output : input.small.output' } },
    ],
    edges: [
      { source: 'cond', target: 'big', sourceHandle: 'true' },
      { source: 'cond', target: 'small', sourceHandle: 'false' },
      { source: 'small', target: 'afterSmall' },
      { source: 'big', target: 'join' },
      { source: 'afterSmall', target: 'join' },
    ],
  };
  const events: RunEventPayload[] = [];
  const { context } = await runPipeline(g, { n: 9 }, { onEvent: (e) => void events.push(e) });
  const final = (id: string) => events.filter((e) => e.nodeId === id).at(-1)!.status;
  assert.equal(final('big'), 'success');
  assert.equal(final('small'), 'skipped');
  assert.equal(final('afterSmall'), 'skipped');
  assert.equal(final('join'), 'success');
  assert.equal(context.join.output, 'big');
});

test('named nodes are addressable by name', async () => {
  const g: Graph = {
    nodes: [
      { id: 'uuid-1', name: 'first', type: 'transform', config: { expression: '41' } },
      { id: 'uuid-2', type: 'llm', config: { provider: 'mock', prompt: 'n={{first.output}}' } },
    ],
    edges: [{ source: 'uuid-1', target: 'uuid-2' }],
  };
  const { context, tokensUsed } = await runPipeline(g, null);
  assert.equal(context['uuid-2'].output, '[mock] n=41');
  assert.ok(tokensUsed > 0);
});

test('a failing node emits error and stops the run', async () => {
  const g: Graph = { nodes: [{ id: 'x', type: 'transform', config: { expression: 'input.missing.deep' } }], edges: [] };
  const events: RunEventPayload[] = [];
  await assert.rejects(runPipeline(g, {}, { onEvent: (e) => void events.push(e) }), NodeExecutionError);
  assert.equal(events.at(-1)!.status, 'error');
});

test('sandbox evaluates expressions but blocks escapes, eval and infinite loops', () => {
  assert.deepEqual(evalExpression('input.a.map(x => x * 2)', { a: [1, 2] }), [2, 4]);
  assert.throws(() => evalExpression('this.constructor.constructor("return process")()', {}));
  assert.throws(() => evalExpression('input.constructor.constructor("return process")()', {}));
  assert.throws(() => evalExpression('eval("1")', {}));
  assert.throws(() => evalExpression('typeof require !== "undefined" ? require("fs") : missing', {}));
  assert.throws(() => evalExpression('(() => { while (true) {} })()', {}, 50), /timed out/);
});

test('http node blocks private addresses', async () => {
  const g: Graph = { nodes: [{ id: 'h', type: 'http', config: { url: 'http://127.0.0.1:6379/' } }], edges: [] };
  await assert.rejects(runPipeline(g, null), /private addresses/);
});

import { after } from 'node:test';
import { prisma, redis } from '../src/db.ts';
after(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});
