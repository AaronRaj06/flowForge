import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cloneGraph } from '../src/lib/cloneGraph.ts';
import { stripSecrets, extractVariables, fillVariables } from '../src/lib/templates.ts';
import { topoSort } from '../src/engine/dag.ts';
import { runPipeline } from '../src/engine/runner.ts';
import { AuthError, NodeExecutionError } from '../src/engine/errors.ts';
import { prisma, redis } from '../src/db.ts';
import { runQueue, queueConnection } from '../src/queue.ts';
import { saveToken, getValidToken } from '../src/integrations/tokens.ts';
import { decrypt, encrypt } from '../src/lib/crypto.ts';
import { chunkText, ingest, search } from '../src/kb/knowledge.ts';
import { encode } from 'gpt-tokenizer';
import { toRows } from '../src/integrations/sheets/actions.ts';
import type { Graph, RunEventPayload } from '../src/engine/types.ts';
import { generatePipeline, suggestFix, parseJsonReply } from '../src/ai/assist.ts';
import type { CompletionRequest } from '../src/llm/provider.ts';
import { runsPerMonth } from '../src/api/pipelines.ts';
import { runAgent } from '../src/engine/nodes/agent.ts';

after(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: 'test-' } } });
  await prisma.$disconnect();
  await runQueue.close(); // the AI assist module pulls in the queue via runs/create
  queueConnection.disconnect();
  redis.disconnect();
});

// ---------- cloneGraph: property-based ----------

function randomDag(seed: number): Graph {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const n = 1 + Math.floor(rnd() * 12);
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `node-${seed}-${i}`, type: 'transform', name: `t${i}`, config: { expression: '1' } as Record<string, any> }));
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd() < 0.3) edges.push({ id: `e${i}-${j}`, source: nodes[i].id, target: nodes[j].id, sourceHandle: rnd() < 0.2 ? 'false' : null });
  // Some configs reference earlier nodes by id, which must be rewritten.
  nodes.forEach((node, i) => i > 0 && rnd() < 0.5 && (node.config.prompt = `see {{${nodes[Math.floor(rnd() * i)].id}.output.x}} and {{input}}`));
  return { nodes, edges };
}

test('cloneGraph preserves structure under fresh ids (200 random graphs)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = randomDag(seed);
    const c = cloneGraph(g);
    const ids = new Set(c.nodes.map((n) => n.id));
    assert.equal(ids.size, g.nodes.length, 'ids unique');
    for (const n of c.nodes) assert.ok(!g.nodes.some((o) => o.id === n.id), 'every id is new');
    for (const e of c.edges) assert.ok(ids.has(e.source) && ids.has(e.target), 'edge endpoints exist');

    // Same shape: map old→new by position and compare edge lists.
    const map = new Map(g.nodes.map((n, i) => [n.id, c.nodes[i].id]));
    assert.deepEqual(c.edges.map((e) => [e.source, e.target, e.sourceHandle]), g.edges.map((e) => [map.get(e.source), map.get(e.target), e.sourceHandle]));
    assert.equal(topoSort(c).length, c.nodes.length);
    // Placeholder references follow the rename; no stale old ids remain.
    const text = JSON.stringify(c.nodes.map((n) => n.config));
    for (const old of g.nodes) assert.ok(!text.includes(old.id));
    c.nodes.forEach((n, i) => g.nodes[i].config.prompt && assert.ok(n.config.prompt.includes('{{input}}')));
  }
});

// ---------- templates ----------

test('templates strip secrets and turn free placeholders into variables', () => {
  const g: Graph = {
    nodes: [
      { id: 'a', name: 'fetch', type: 'http', config: { url: 'https://api.x.dev/{{city}}', headers: '{"Authorization":"Bearer sk-123","Accept":"json"}', apiKey: 'sk-1', maxTokens: 5 } },
      { id: 'b', name: 'write', type: 'llm', config: { prompt: 'Tone {{tone}}: {{fetch.output}} {{a.output}} {{input}}' } },
    ],
    edges: [{ source: 'a', target: 'b' }],
  };
  const clean = stripSecrets(g);
  assert.equal(clean.nodes[0].config.apiKey, undefined);
  assert.equal(clean.nodes[0].config.maxTokens, 5, 'non-secret keys containing "token" survive');
  assert.deepEqual(JSON.parse(clean.nodes[0].config.headers), { Accept: 'json' });
  assert.deepEqual(extractVariables(clean).map((v) => v.key), ['city', 'tone']);
  const filled = fillVariables(clean, { city: 'paris', tone: 'warm' });
  assert.equal(filled.nodes[0].config.url, 'https://api.x.dev/paris');
  assert.equal(filled.nodes[1].config.prompt, 'Tone warm: {{fetch.output}} {{a.output}} {{input}}');
});

// ---------- integrations: token refresh + revocation ----------

type Route = (url: string, init?: RequestInit) => Response | undefined;
function stubFetch(route: Route) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => route(String(input instanceof URL ? input.href : input), init) ?? real(input, init)) as typeof fetch;
  return () => void (globalThis.fetch = real);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function testUser() {
  return prisma.user.create({ data: { email: `test-${crypto.randomUUID()}@flowforge.dev`, passwordHash: '!' } });
}

test('getValidToken refreshes expired tokens and reports revoked grants as AuthError', async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  const user = await testUser();
  await saveToken(user.id, 'gmail', { accessToken: 'old', refreshToken: 'r1', expiresAt: new Date(Date.now() - 1000) });

  const row = await prisma.integrationToken.findUniqueOrThrow({ where: { userId_provider: { userId: user.id, provider: 'gmail' } } });
  assert.notEqual(row.accessToken, 'old', 'stored encrypted');
  assert.equal(decrypt(row.accessToken), 'old');

  let revoked = false;
  const restore = stubFetch((url) =>
    url === 'https://oauth2.googleapis.com/token' ? (revoked ? json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) : json({ access_token: 'fresh', expires_in: 3600 })) : undefined,
  );
  try {
    assert.equal(await getValidToken(user.id, 'gmail'), 'fresh');
    const updated = await prisma.integrationToken.findUniqueOrThrow({ where: { userId_provider: { userId: user.id, provider: 'gmail' } } });
    assert.ok(updated.expiresAt! > new Date());
    assert.equal(decrypt(updated.refreshToken!), 'r1', 'refresh token kept when Google omits it');
    assert.equal(await getValidToken(user.id, 'gmail'), 'fresh', 'no refresh while valid');

    await prisma.integrationToken.update({ where: { id: updated.id }, data: { expiresAt: new Date(0) } });
    revoked = true;
    await assert.rejects(getValidToken(user.id, 'gmail'), AuthError);
    await assert.rejects(getValidToken(user.id, 'slack'), /not connected/);
  } finally {
    restore();
  }
});

test('Sheets → LLM → Gmail runs end to end; a revoked Gmail token gives auth_error', async () => {
  const user = await testUser();
  const far = new Date(Date.now() + 3600_000);
  await saveToken(user.id, 'sheets', { accessToken: 'sheets-token', expiresAt: far });
  await saveToken(user.id, 'gmail', { accessToken: 'gmail-token', expiresAt: far });

  const sent: any[] = [];
  let gmailRevoked = false;
  const restore = stubFetch((url, init) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/SHEET1/values/')) {
      assert.equal(auth, 'Bearer sheets-token');
      return json({ values: [['name', 'task'], ['Ada', 'ship the release']] });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      if (gmailRevoked) return json({ error: { message: 'Invalid Credentials' } }, 401);
      sent.push(JSON.parse(String(init!.body)));
      return json({ id: 'msg-1' });
    }
  });

  const graph: Graph = {
    nodes: [
      { id: 's', name: 'sheet', type: 'sheetsRead', config: { spreadsheetId: 'SHEET1', range: 'A1:B10' } },
      { id: 'l', name: 'draft', type: 'llm', config: { provider: 'mock', prompt: 'Remind {{sheet.output.0.name}} to {{sheet.output.0.task}}' } },
      { id: 'g', name: 'email', type: 'gmail', config: { to: 'ada@example.com', subject: 'Reminder\r\nBcc: evil@x.com', body: '{{draft.output}}' } },
    ],
    edges: [{ source: 's', target: 'l' }, { source: 'l', target: 'g' }],
  };
  try {
    const { context } = await runPipeline(graph, null, { userId: user.id });
    assert.deepEqual(context.sheet.output, [{ name: 'Ada', task: 'ship the release' }]);
    assert.equal(context.email.output.messageId, 'msg-1');
    const mime = Buffer.from(sent[0].raw, 'base64url').toString();
    assert.match(mime, /^To: ada@example.com\r\nSubject: Reminder Bcc: evil@x.com\r\n/, 'no header injection');
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), '[mock] Remind Ada to ship the release');

    gmailRevoked = true;
    const events: RunEventPayload[] = [];
    await assert.rejects(runPipeline(graph, null, { userId: user.id, onEvent: (e) => void events.push(e) }), NodeExecutionError);
    const last = events.filter((e) => e.nodeId === 'g').at(-1)!;
    assert.equal(last.status, 'auth_error');
    assert.match(last.error!, /Reconnect/);
  } finally {
    restore();
  }
});

test('sheets values accept rows, objects, and JSON strings', () => {
  assert.deepEqual(toRows([[1, 2]]), [[1, 2]]);
  assert.deepEqual(toRows([{ a: 1, b: 2 }]), [[1, 2]]);
  assert.deepEqual(toRows('[["x"]]'), [['x']]);
  assert.deepEqual(toRows('hello'.length), [[5]]);
});

// ---------- knowledge base ----------

test('chunking uses exact 500-token windows with a 50-token overlap', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
  const chunks = chunkText(words);
  const total = encode(words).length;
  assert.ok(chunks.slice(0, -1).every((c) => encode(c).length >= 498 && encode(c).length <= 500), chunks.map((c) => encode(c).length).join());
  assert.equal(chunks.length, Math.ceil((total - 50) / 450));
  const tail = chunks[0].split(' ').slice(-3).join(' ');
  assert.ok(chunks[1].includes(tail), 'consecutive chunks overlap');
  assert.ok(chunks.at(-1)!.endsWith('w999'));
});

test('KB ingest + KB Query node retrieves the relevant chunk', async () => {
  const user = await testUser();
  await ingest(user.id, 'pets.txt', 'Cats are independent animals that sleep most of the day and groom themselves.');
  await ingest(user.id, 'finance.txt', 'Quarterly revenue grew because the sales team closed three enterprise deals.');
  const hits = await search(user.id, 'why did revenue grow this quarter');
  assert.equal(hits[0].sourceFile, 'finance.txt');

  const { context } = await runPipeline(
    {
      nodes: [
        { id: 'k', name: 'kbQuery', type: 'kbQuery', config: { query: '{{input}}' } },
        { id: 'l', type: 'llm', config: { provider: 'mock', prompt: 'Context: {{kbQuery.output}}' } },
      ],
      edges: [{ source: 'k', target: 'l' }],
    },
    'do cats sleep a lot',
    { userId: user.id },
  );
  assert.ok(context.kbQuery.output.startsWith('Cats are independent'));
  assert.match(context.l.output, /Context: Cats are independent/);
});

// ---------- AI assist ----------

test('Build with AI repairs one bad reply, validates, lays out, and bills tokens', async () => {
  const user = await prisma.user.create({ data: { email: `test-ai-${Date.now()}@x.dev`, passwordHash: 'x' } });
  const prompts: string[] = [];
  const replies = [
    'Sure! {"nodes":[{"id":"a","type":"nope","config":{}}],"edges":[]}',
    '```json\n{"nodes":[{"id":"fetch","type":"http","config":{"url":"https://example.com"}},{"id":"sum","type":"llm","config":{"prompt":"Summarize {{fetch.output}}"}}],"edges":[{"source":"fetch","target":"sum"}]}\n```',
  ];
  const fake = async (req: CompletionRequest) => (prompts.push(req.prompt), { text: replies.shift()!, inputTokens: 10, outputTokens: 5 });
  const g = await generatePipeline(user.id, 'summarize a web page', fake);
  assert.deepEqual(g.nodes.map((n) => [n.name, n.position!.x]), [['fetch', 80], ['sum', 380]]);
  assert.deepEqual(g.edges.map((e) => [e.source, e.target]), [[g.nodes[0].id, g.nodes[1].id]]);
  assert.match(g.nodes[0].id, /^[0-9a-f-]{36}$/);
  assert.match(prompts[1], /Unknown node type "nope"/);
  const billed = await prisma.run.aggregate({ where: { userId: user.id }, _sum: { tokensUsed: true } });
  assert.equal(billed._sum.tokensUsed, 30);
  await assert.rejects(generatePipeline(user.id, 'x', async () => ({ text: 'no json', inputTokens: 0, outputTokens: 0 })), /couldn’t produce a valid pipeline/);
});

test('Fix with AI never shows secrets to the model and keeps them on apply', async () => {
  const user = await prisma.user.create({ data: { email: `test-fix-${Date.now()}@x.dev`, passwordHash: 'x' } });
  let seen = '';
  const fake = async (req: CompletionRequest) => ((seen = req.prompt), { text: '{"explanation":"Use https.","config":{"url":"https://api.example.com"}}', inputTokens: 1, outputTokens: 1 });
  const node = { type: 'http', name: 'call', config: { url: 'htp://api.example.com', apiKey: 'sk-secret-123', headers: '{"Authorization":"Bearer abc"}' } };
  const fix = await suggestFix(user.id, node, 'Invalid URL', fake);
  assert.ok(!seen.includes('sk-secret-123') && !seen.includes('Bearer abc'), seen);
  assert.equal(fix.config.url, 'https://api.example.com');
  assert.equal(fix.config.apiKey, 'sk-secret-123');
  assert.deepEqual(fix.changes, { url: 'https://api.example.com' });
  assert.deepEqual(parseJsonReply('x {"a":{"b":1}} y'), { a: { b: 1 } });
});

test('runsPerMonth projects schedules over 30 days', () => {
  assert.equal(runsPerMonth('0 9 1 * *') >= 1 && runsPerMonth('0 9 1 * *') <= 2, true);
  const daily = runsPerMonth('0 9 * * *');
  assert.ok(daily >= 29 && daily <= 31, String(daily));
  assert.equal(runsPerMonth('* * * * *', 500), 500);
});

test('agent can run one of the user’s pipelines as a tool, but not someone else’s', async () => {
  const user = await testUser();
  const other = await testUser();
  const double = { nodes: [{ id: 'd', name: 'doubled', type: 'transform', config: { expression: 'input.input.n * 2' } }], edges: [] };
  const mine = await prisma.pipeline.create({ data: { userId: user.id, name: 'Double It', graph: double } });
  const theirs = await prisma.pipeline.create({ data: { userId: other.id, name: 'Secret', graph: double } });
  const replies = ['{"tool":"pipeline_secret","args":{"input":{"n":1}}}', '{"tool":"pipeline_double_it","args":{"input":{"n":21}}}', '{"answer":"done"}'];
  const fake = async () => ({ text: replies.shift()!, inputTokens: 1, outputTokens: 1 });
  const out = await runAgent({ prompt: 'double 21', tools: [`pipeline:${mine.id}`, `pipeline:${theirs.id}`] }, { nodeId: 'a', context: {}, inputs: {}, userId: user.id, depth: 0, addTokens: () => {} }, fake);
  assert.equal(out.steps[0].error, 'No tool called pipeline_secret');
  assert.equal(out.steps[1].result, '{"doubled":42}');
});

test('key-based blocks call the right API with the stored secret, and refuse other users’ credentials', async () => {
  const user = await testUser();
  const other = await testUser();
  const mk = (userId: string, type: string, secret: string) => prisma.credential.create({ data: { userId, name: `${type}-${Math.random()}`, type, secret: encrypt(secret) } });
  const creds = {
    discord: await mk(user.id, 'discord', 'https://discord.com/api/webhooks/1/abc'),
    telegram: await mk(user.id, 'telegram', '123:tok'),
    notion: await mk(user.id, 'notion', 'secret_n'),
    github: await mk(user.id, 'github', 'ghp_g'),
    airtable: await mk(user.id, 'airtable', 'pat.a'),
  };
  const theirs = await mk(other.id, 'github', 'ghp_theirs');
  const calls: { url: string; auth?: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    const status = String(url).includes('/denied/') ? 401 : 200;
    return new Response(JSON.stringify({ id: 'p1', url: 'u', number: 7, html_url: 'h', records: [{ id: 'r1' }], result: { message_id: 9 } }), { status });
  }) as typeof fetch;
  try {
    const g: Graph = {
      nodes: [
        { id: 'd', type: 'discord', config: { credential: creds.discord.id, content: 'hi {{input}}' } },
        { id: 't', type: 'telegram', config: { credential: creds.telegram.id, chatId: '42', text: 'hi' } },
        { id: 'n', type: 'notion', config: { credential: creds.notion.id, databaseId: 'db-1', title: 'T', content: 'C' } },
        { id: 'g', type: 'github', config: { credential: creds.github.id, repo: 'o/r', title: 'Bug' } },
        { id: 'a', type: 'airtable', config: { credential: creds.airtable.id, baseId: 'app1', table: 'Leads', fields: '{"Name": "{{input}}"}' } },
      ],
      edges: [],
    };
    const { context } = await runPipeline(g, 'Ada', { userId: user.id });
    assert.deepEqual(calls.map((c) => c.url), [
      'https://discord.com/api/webhooks/1/abc?wait=true',
      'https://api.telegram.org/bot123:tok/sendMessage',
      'https://api.notion.com/v1/pages',
      'https://api.github.com/repos/o/r/issues',
      'https://api.airtable.com/v0/app1/Leads',
    ]);
    assert.equal(calls[0].body.content, 'hi Ada');
    assert.equal(calls[2].auth, 'Bearer secret_n');
    assert.equal(calls[2].body.parent.database_id, 'db1');
    assert.deepEqual(calls[4].body.records[0].fields, { Name: 'Ada' });
    assert.deepEqual([context.g.output, context.a.output, context.t.output], [{ number: 7, url: 'h' }, { recordId: 'r1' }, { messageId: 9 }]);

    await assert.rejects(runPipeline({ nodes: [{ id: 'x', type: 'github', config: { credential: theirs.id, repo: 'o/r', title: 't' } }], edges: [] }, null, { userId: user.id }), /credential not found/);
    await assert.rejects(runPipeline({ nodes: [{ id: 'x', type: 'github', config: { credential: creds.notion.id, repo: 'o/r', title: 't' } }], edges: [] }, null, { userId: user.id }), /credential not found/);
    await assert.rejects(runPipeline({ nodes: [{ id: 'x', type: 'github', config: { credential: creds.github.id, repo: 'o/denied', title: 't' } }], edges: [] }, null, { userId: user.id }), /rejected the credential \(HTTP 401\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
