import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topoSort } from '../src/engine/dag.ts';
import { resolveConfig, findPlaceholders } from '../src/engine/template.ts';
import { runPipeline } from '../src/engine/runner.ts';
import { evalExpression } from '../src/engine/sandbox.ts';
import { ApprovalPending, CyclicDependencyError, MissingVariableError, NodeExecutionError } from '../src/engine/errors.ts';
import { runAgent } from '../src/engine/nodes/agent.ts';
import { http, guardedLookup } from '../src/engine/nodes/http.ts';
import type { CompletionRequest } from '../src/llm/provider.ts';
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

test('loop runs its body once per item and merge collects the results', async () => {
  const g: Graph = {
    nodes: [
      { id: 'L', name: 'each', type: 'loop', config: { items: 'input.input.names' } },
      { id: 'G', name: 'greet', type: 'transform', config: { expression: '"hi " + input.item + " #" + input.index' } },
      { id: 'M', name: 'all', type: 'merge', config: {} },
      { id: 'J', type: 'transform', config: { expression: 'input.all.output.join(", ")' } },
    ],
    edges: [{ source: 'L', target: 'G' }, { source: 'G', target: 'M' }, { source: 'M', target: 'J' }],
  };
  const events: RunEventPayload[] = [];
  const { context } = await runPipeline(g, { names: ['Ada', 'Lin'] }, { onEvent: (e) => void events.push(e) });
  assert.deepEqual(context.each.output, { count: 2, items: ['Ada', 'Lin'] });
  assert.deepEqual(context.greet.output, ['hi Ada #0', 'hi Lin #1']);
  assert.equal(context.J.output, 'hi Ada #0, hi Lin #1');
  assert.equal(events.filter((e) => e.nodeId === 'G').at(-1)!.status, 'success');
});

test('merge outside a loop combines live branches by name', async () => {
  const g: Graph = {
    nodes: [
      { id: 'a', name: 'a', type: 'transform', config: { expression: '1' } },
      { id: 'b', name: 'b', type: 'transform', config: { expression: '2' } },
      { id: 'm', type: 'merge', config: {} },
    ],
    edges: [{ source: 'a', target: 'm' }, { source: 'b', target: 'm' }],
  };
  assert.deepEqual((await runPipeline(g, null)).context.m.output, { a: 1, b: 2 });
});

test('loops reject non-lists, nested loops, and body blocks wired from outside', async () => {
  const one = (items: string): Graph => ({ nodes: [{ id: 'L', type: 'loop', config: { items } }], edges: [] });
  await assert.rejects(runPipeline(one('42'), null), /must be a list/);
  const nested: Graph = {
    nodes: [{ id: 'L1', type: 'loop', config: { items: '[1]' } }, { id: 'L2', type: 'loop', config: { items: '[1]' } }],
    edges: [{ source: 'L1', target: 'L2' }],
  };
  await assert.rejects(runPipeline(nested, null), /Loops inside loops/);
  const wired: Graph = {
    nodes: [
      { id: 'x', type: 'transform', config: { expression: '1' } },
      { id: 'L', type: 'loop', config: { items: '[1]' } },
      { id: 'b', type: 'transform', config: { expression: '2' } },
    ],
    edges: [{ source: 'L', target: 'b' }, { source: 'x', target: 'b' }],
  };
  await assert.rejects(runPipeline(wired, null), /outside it/);
});

test('retries re-run a failing block, then continueOnFail lets the run go on', async () => {
  // Fails while the run input says so; the counter lives in a closure the sandbox can't see, so use attempts via events.
  const g: Graph = {
    nodes: [
      { id: 'bad', name: 'bad', type: 'transform', config: { expression: 'input.nope.deep', retries: 2, retryDelayMs: 1, continueOnFail: true } },
      { id: 'after', type: 'transform', config: { expression: 'input.bad.error' } },
    ],
    edges: [{ source: 'bad', target: 'after' }],
  };
  const events: RunEventPayload[] = [];
  const { context } = await runPipeline(g, null, { onEvent: (e) => void events.push(e) });
  assert.match(context.after.output, /after 3 attempts/);
  assert.equal(events.filter((e) => e.nodeId === 'bad').at(-1)!.status, 'error');
  g.nodes[0].config.continueOnFail = false;
  await assert.rejects(runPipeline(g, null), NodeExecutionError);
});

test('tokens are tracked per block, a per-run limit stops the run, and failures still report tokens', async () => {
  const g: Graph = {
    nodes: [
      { id: 'a', type: 'llm', config: { provider: 'mock', prompt: 'x'.repeat(400) } },
      { id: 'b', type: 'llm', config: { provider: 'mock', prompt: 'second' } },
    ],
    edges: [{ source: 'a', target: 'b' }],
  };
  const events: RunEventPayload[] = [];
  const ok = await runPipeline(g, null, { onEvent: (e) => void events.push(e) });
  const tokA = events.find((e) => e.nodeId === 'a' && e.status === 'success')!.tokens!;
  const tokB = events.find((e) => e.nodeId === 'b' && e.status === 'success')!.tokens!;
  assert.ok(tokA > 100 && tokB > 0);
  assert.equal(ok.tokensUsed, tokA + tokB);
  const err: any = await runPipeline(g, null, { maxTokens: 100 }).catch((e) => e);
  assert.ok(err instanceof NodeExecutionError && err.nodeId === 'b', String(err));
  assert.match(err.message, /Token limit reached/);
  assert.equal(err.tokensUsed, tokA);
});

test('approval pauses the run, then resumes on the chosen branch without re-running earlier blocks', async () => {
  const g: Graph = {
    nodes: [
      { id: 'pre', type: 'transform', config: { expression: 'input.input * 2' } },
      { id: 'ok', type: 'approval', config: { message: 'Send {{pre.output}}?' } },
      { id: 'yes', type: 'transform', config: { expression: '"sent"' } },
      { id: 'no', type: 'transform', config: { expression: '"held"' } },
    ],
    edges: [{ source: 'pre', target: 'ok' }, { source: 'ok', target: 'yes', sourceHandle: 'true' }, { source: 'ok', target: 'no', sourceHandle: 'false' }],
  };
  const events: RunEventPayload[] = [];
  const err = await runPipeline(g, 21, { onEvent: (e) => void events.push(e) }).catch((e) => e);
  assert.ok(err instanceof ApprovalPending, String(err));
  assert.equal(err.request, 'Send 42?');
  const statuses = Object.fromEntries(events.map((e) => [e.nodeId, e.status]));
  assert.equal(statuses.ok, 'waiting');
  assert.equal(statuses.yes, 'pending');

  err.context!.__approvals = { ok: { approved: false } };
  const again: RunEventPayload[] = [];
  const res = await runPipeline(g, 21, { resume: { context: err.context!, statuses }, onEvent: (e) => void again.push(e) });
  assert.equal(res.context.no.output, 'held');
  assert.equal(res.context.yes, undefined);
  assert.ok(!again.some((e) => e.nodeId === 'pre'), 'pre ran once');
  assert.deepEqual(again.map((e) => `${e.nodeId}:${e.status}`), ['ok:running', 'ok:success', 'yes:skipped', 'no:running', 'no:success']);
});

test('approval blocks are refused inside loops', async () => {
  const g: Graph = {
    nodes: [{ id: 'l', type: 'loop', config: { items: '[1]' } }, { id: 'a', type: 'approval', config: {} }],
    edges: [{ source: 'l', target: 'a' }],
  };
  await assert.rejects(runPipeline(g, null), /can't be inside a loop/);
});

test('agent calls tools until it answers, and feeds tool errors back to the model', async () => {
  const replies = ['{"tool":"nope","args":{}}', 'Done. {"answer": "42"}'];
  const prompts: string[] = [];
  const fake = async (req: CompletionRequest) => (prompts.push(req.prompt), { text: replies.shift()!, inputTokens: 1, outputTokens: 2 });
  let tokens = 0;
  const out = await runAgent({ prompt: 'answer it', tools: [] }, { nodeId: 'a', context: {}, inputs: {}, depth: 0, addTokens: (t) => (tokens += t) }, fake);
  assert.deepEqual(out, { answer: '42', steps: [{ tool: 'nope', args: {}, error: 'No tool called nope' }] });
  assert.equal(tokens, 6);
  assert.match(prompts[1], /It failed: No tool called nope/);
  // A plain-text reply is the answer (this is what the mock provider gives).
  const plain = await runAgent({ prompt: 'hi', tools: [] }, { nodeId: 'a', context: {}, inputs: {}, depth: 0, addTokens: () => {} }, async () => ({ text: 'hello', inputTokens: 0, outputTokens: 0 }));
  assert.equal(plain.answer, 'hello');
});

test('HTTP block: the connection-time DNS guard refuses private addresses (closes DNS rebinding)', async () => {
  const err = await new Promise<Error | null>((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
  assert.match(String(err?.message), /private addresses are blocked/);
  await assert.rejects(http.run({ url: 'http://127.0.0.1:9/x' }, { nodeId: 'h', context: {}, inputs: {}, depth: 0, addTokens: () => {} }), /private addresses are blocked/);
  await assert.rejects(http.run({ url: 'file:///etc/passwd' }, { nodeId: 'h', context: {}, inputs: {}, depth: 0, addTokens: () => {} }), /Unsupported protocol/);
});

test('LLM: a temporary failure on the main model falls back to LLM_FALLBACK_MODEL once', async () => {
  const { complete } = await import('../src/llm/provider.ts');
  const OpenAI = (await import('openai')).default;
  const seen: string[] = [];
  const orig = OpenAI.Chat.Completions.prototype.create;
  OpenAI.Chat.Completions.prototype.create = async function (body: any) {
    seen.push(body.model);
    if (body.model === 'main') throw Object.assign(new Error('overloaded'), { status: 503 });
    return { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } as any;
  } as any;
  const env = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: '', LLM_FALLBACK_MODEL: 'backup', LLM_MAX_RETRIES: '0' });
  try {
    const res = await complete({ provider: 'openai', model: 'main', prompt: 'hi' });
    assert.equal(res.text, 'ok');
    assert.deepEqual(seen, ['main', 'backup']);
  } finally {
    OpenAI.Chat.Completions.prototype.create = orig;
    process.env = env;
  }
});
