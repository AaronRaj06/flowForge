import { complete, pickProvider, type Completion, type CompletionRequest } from '../llm/provider.ts';
import { prisma } from '../db.ts';
import { HttpError, parseGraph } from '../api/http.ts';
import { dailyBudget, tokensUsedToday } from '../runs/create.ts';
import { stripSecrets } from '../lib/templates.ts';
import { topoSort } from '../engine/dag.ts';
import { cloneGraph } from '../lib/cloneGraph.ts';
import type { Graph, NodeDef } from '../engine/types.ts';

type CompleteFn = (req: CompletionRequest) => Promise<Completion>;

/** What the model may build with. Keep in step with engine/nodes and web/src/lib/nodeTypes.ts. */
export const CATALOG = `Block types (type: config keys):
- llm: { prompt, systemPrompt? }: calls an LLM, output is the reply text
- http: { method: GET|POST|PUT|PATCH|DELETE, url, headers?: JSON string, body?: string }: output is the parsed response
- transform: { expression }: JavaScript expression; \`input\` is the run context (input.input = run input, input.<name>.output = a block's output)
- conditional: { expression }: JavaScript boolean; edges out of it need sourceHandle "true" or "false"
- loop: { items }: JavaScript expression giving a list; every block after it up to a merge runs once per item ({{item}}, {{index}})
- merge: {}: collects loop results into a list, or joins branches
- delay: { duration }: milliseconds, max 300000
- webhook: {}: trigger; use as the first block when the pipeline starts from an inbound webhook
- gmail: { to, subject, body }: sends an email
- slack: { channel, text }: posts a Slack message
- sheetsRead: { spreadsheetId, range }: output is rows as objects
- sheetsWrite: { spreadsheetId, range, values }: values is a 2D array or list of objects
- kbQuery: { query }: searches the user's uploaded documents, output is matching text
- approval: { message, notifyEmail?, notifySlack? }: pauses until a person approves or rejects; edges out of it need sourceHandle "true" (approved) or "false" (rejected)
- agent: { prompt, tools: ["http", "kb"] }: an LLM that decides for itself which tools to call; output is { answer, steps }
- discord: { content }, telegram: { chatId, text }, notion: { databaseId, title, content? }, github: { repo: "owner/name", title, body? }, airtable: { baseId, table, fields: JSON object string }: send to those services; leave "credential" as "" (the user picks one)
Text fields can reference data with {{input}}, {{name.output}} or {{name.output.path.0.field}}. JavaScript fields use input.name.output instead.`;

/** Pulls the first JSON object out of a model reply, tolerating code fences and chatter. */
export function parseJsonReply(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Reply contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

/** Left-to-right layout: column = longest path from a root, rows stacked within a column. */
export function layout(graph: Graph): Graph {
  const depth = new Map<string, number>();
  for (const n of topoSort(graph)) {
    const preds = graph.edges.filter((e) => e.target === n.id).map((e) => depth.get(e.source)!);
    depth.set(n.id, preds.length ? Math.max(...preds) + 1 : 0);
  }
  const rows = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const col = depth.get(n.id)!;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      return { ...n, position: { x: 80 + col * 300, y: 80 + row * 160 } };
    }),
  };
}

async function ask(userId: string, req: CompletionRequest, completeFn: CompleteFn, what: string) {
  if (completeFn === complete && pickProvider() === 'mock') {
    throw new HttpError(400, `${what} needs a real LLM. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) in server/.env.`);
  }
  const used = await tokensUsedToday(userId);
  if (used >= dailyBudget()) throw new HttpError(429, `Daily token budget used up (${used.toLocaleString()} / ${dailyBudget().toLocaleString()}).`);
  const res = await completeFn(req);
  // AI-assist calls aren't pipeline runs, but their tokens still count toward the budget.
  await prisma.run.create({
    data: { userId, graph: { nodes: [], edges: [] }, input: { aiAssist: what }, status: 'SUCCESS', tokensUsed: res.inputTokens + res.outputTokens, finishedAt: new Date() },
  });
  return res.text;
}

const GENERATE_SYSTEM = `You design automation pipelines for Flowforge, a visual workflow builder.
${CATALOG}

Reply with ONLY a JSON object: {"nodes":[{"id","type","config"}],"edges":[{"source","target","sourceHandle"?}]}.
Ids are short, unique, lowercase letters/digits/underscores (e.g. "fetch", "summary"); reference other blocks by id. Edges must form a DAG.
Use the fewest blocks that do the job. Leave values the user must supply (emails, channels, spreadsheet ids, URLs) as clear placeholders like "you@example.com".`;

/** Plain-English description in, validated and laid-out graph out. One repair round if the first reply is invalid. */
export async function generatePipeline(userId: string, description: string, completeFn: CompleteFn = complete): Promise<Graph> {
  const prompt = `Build a pipeline for: ${description}`;
  let reply = await ask(userId, { system: GENERATE_SYSTEM, prompt }, completeFn, 'Build with AI');
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = parseJsonReply(reply);
      // The id is what the model references ({{fetch.output}}, input.fetch); it becomes the name, since ids are replaced with UUIDs below.
      raw.nodes = (raw.nodes ?? []).map((n: any) => ({ ...n, id: String(n.id), name: String(n.id).replace(/[^\w-]/g, '_'), config: n.config ?? {} }));
      if (!raw.nodes.length) throw new Error('Pipeline has no blocks');
      return layout(cloneGraph(parseGraph(raw))); // fresh UUIDs, like blocks added by hand
    } catch (err) {
      if (attempt >= 1) throw new HttpError(502, `The AI couldn’t produce a valid pipeline (${(err as Error).message}). Try describing it differently.`);
      reply = await ask(userId, { system: GENERATE_SYSTEM, prompt: `${prompt}\n\nYour previous reply was invalid: ${(err as Error).message}\nPrevious reply:\n${reply}\n\nReply again with only the corrected JSON.` }, completeFn, 'Build with AI');
    }
  }
}

const FIX_SYSTEM = `You debug blocks in Flowforge, a visual workflow builder.
${CATALOG}

You get one block's type, name, config and the error it raised. Reply with ONLY a JSON object:
{"explanation": "<one or two plain sentences: what went wrong and what you changed>", "config": {<only the config keys you changed>}}.
If the problem can't be fixed inside this block (missing credentials, a remote server down, wrong data upstream), explain that and return "config": {}.`;

/** Suggests a config change for a failed block. Secrets are redacted before the model sees them and kept as they were. */
export async function suggestFix(userId: string, node: Pick<NodeDef, 'type' | 'name' | 'config'>, error: string, completeFn: CompleteFn = complete) {
  const [redacted] = stripSecrets({ nodes: [{ id: 'n', ...node }], edges: [] }).nodes;
  const prompt = `Block type: ${node.type}\nName: ${node.name ?? 'n'}\nConfig: ${JSON.stringify(redacted.config, null, 2)}\nError: ${error}`;
  const reply = await ask(userId, { system: FIX_SYSTEM, prompt }, completeFn, 'Fix with AI');
  let parsed: any;
  try {
    parsed = parseJsonReply(reply);
  } catch {
    throw new HttpError(502, 'The AI reply couldn’t be read. Try again.');
  }
  const changes = parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config) ? parsed.config : {};
  return { explanation: String(parsed.explanation ?? '').slice(0, 1000), changes, config: { ...node.config, ...changes } };
}
