import type { Graph, NodeContext, NodeHandler } from '../types.ts';
import { complete, type Completion, type CompletionRequest } from '../../llm/provider.ts';
import { prisma } from '../../db.ts';
import { editablePipelines } from '../../lib/access.ts';
import { http } from './http.ts';
import { kbQuery } from './kb.ts';

type CompleteFn = (req: CompletionRequest) => Promise<Completion>;
type Tool = { name: string; description: string; run: (args: any) => Promise<unknown> };

const MAX_STEPS = 8;
const MAX_DEPTH = 3;
const clip = (v: unknown, n = 4000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** Pulls the first JSON object out of a reply; null when the reply is plain text. */
function parseJson(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function buildTools(selected: string[], ctx: NodeContext): Promise<Tool[]> {
  const tools: Tool[] = [];
  if (selected.includes('http')) {
    tools.push({ name: 'http_request', description: 'args {method, url, headers?, body?}: calls a public URL, returns the response', run: (a) => http.run(a ?? {}, ctx) });
  }
  if (selected.includes('kb')) {
    tools.push({ name: 'search_knowledge', description: "args {query}: searches the user's uploaded documents", run: (a) => kbQuery.run({ query: a?.query, topK: 5 }, ctx) });
  }
  const ids = selected.filter((t) => t.startsWith('pipeline:')).map((t) => t.slice(9));
  if (ids.length) {
    if (ctx.depth >= MAX_DEPTH) throw new Error(`Agents can call pipelines at most ${MAX_DEPTH} levels deep`);
    if (!ctx.userId) throw new Error('Pipeline tools need a signed-in user');
    const pipelines = await prisma.pipeline.findMany({ where: { id: { in: ids }, ...editablePipelines(ctx.userId) }, select: { id: true, name: true, description: true, graph: true } });
    const { runPipeline } = await import('../runner.ts'); // runner imports the handlers, so load it lazily
    for (const p of pipelines) {
      tools.push({
        name: `pipeline_${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
        description: `args {input}: runs the "${p.name}" pipeline${p.description ? ` (${p.description})` : ''}, returns its final outputs`,
        async run(a) {
          const graph = p.graph as unknown as Graph;
          const res = await runPipeline(graph, a?.input ?? null, { userId: ctx.userId, signal: ctx.signal, depth: ctx.depth + 1 });
          ctx.addTokens(res.tokensUsed);
          const sinks = graph.nodes.filter((n) => !graph.edges.some((e) => e.source === n.id));
          return Object.fromEntries(sinks.map((n) => [n.name || n.id, res.context[n.id]?.output ?? null]));
        },
      });
    }
  }
  return tools;
}

/** LLM in a loop: each turn it calls one tool (as JSON) or gives its answer. A plain-text reply counts as the answer. */
export async function runAgent(config: Record<string, any>, ctx: NodeContext, completeFn: CompleteFn = complete) {
  const task = String(config.prompt ?? '');
  if (!task.trim()) throw new Error('Agent block needs a task');
  const tools = await buildTools(Array.isArray(config.tools) ? config.tools.map(String) : [], ctx);
  const system = `${config.systemPrompt ? config.systemPrompt + '\n\n' : ''}You are an agent that completes a task step by step.
Tools:
${tools.length ? tools.map((t) => `- ${t.name}: ${t.description}`).join('\n') : '(none: answer directly)'}
Each turn, reply with ONLY one JSON object: {"tool": "<name>", "args": {...}} to call a tool, or {"answer": "<final answer>"} when done.`;

  let transcript = `Task: ${task}`;
  const steps: { tool: string; args: unknown; result?: string; error?: string }[] = [];
  for (let i = 0; i < MAX_STEPS; i++) {
    ctx.signal?.throwIfAborted();
    const res = await completeFn({ provider: config.provider, model: config.model, system, prompt: transcript, signal: ctx.signal });
    ctx.addTokens(res.inputTokens + res.outputTokens);
    const msg = parseJson(res.text);
    if (!msg?.tool) return { answer: msg && 'answer' in msg ? msg.answer : res.text, steps };
    const tool = tools.find((t) => t.name === msg.tool);
    const step: (typeof steps)[number] = { tool: String(msg.tool), args: msg.args ?? {} };
    try {
      if (!tool) throw new Error(`No tool called ${msg.tool}`);
      step.result = clip(await tool.run(msg.args));
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      step.error = (err as Error).message; // the model sees the error and can try something else
    }
    steps.push(step);
    transcript += `\n\nYou called ${step.tool} with ${clip(step.args, 500)}.\n${step.error ? `It failed: ${step.error}` : `It returned: ${step.result}`}`;
  }
  throw new Error(`Agent didn't finish within ${MAX_STEPS} steps`);
}

export const agent: NodeHandler = { run: (config, ctx) => runAgent(config, ctx) };
