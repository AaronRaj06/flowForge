// End-to-end check against a running API + worker: npm run smoke
// Registers a throwaway user and exercises each feature over HTTP.
import assert from 'node:assert/strict';

const BASE = process.env.API_URL ?? 'http://localhost:4000';
let token = '';

async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...(init.json !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }), ...init.headers },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

/** Collect SSE events for a run until "done". */
async function stream(runId: string) {
  const res = await fetch(`${BASE}/api/runs/${runId}/stream?token=${token}`);
  const events: any[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body!) {
    buf += decoder.decode(chunk, { stream: true });
    for (const block of buf.split('\n\n').slice(0, -1)) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    if (events.at(-1)?.type === 'done') break;
  }
  return events;
}

const step = async (name: string, fn: () => Promise<void>) => {
  await fn();
  console.log(`✓ ${name}`);
};

const only = process.argv.slice(2);
const want = (phase: string) => !only.length || only.includes(phase);

await step('register', async () => {
  const r = await api('/api/auth/register', { method: 'POST', json: { email: `smoke-${Date.now()}@flowforge.dev`, password: 'password123' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  token = r.body.token;
});

const graph = {
  nodes: [
    { id: 'a', type: 'llm', name: 'summary', config: { prompt: 'Summarize {{input}}' } },
    { id: 'b', type: 'delay', config: { duration: 200 } },
    { id: 'c', type: 'transform', config: { expression: 'input.summary.output.length' } },
  ],
  edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
};

if (want('p2')) {
  await step('run streams live node statuses over SSE', async () => {
    const r = await api('/api/runs', { method: 'POST', json: { graph, input: 'hello world' } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const events = await stream(r.body.runId);
    const statuses = events.filter((e) => e.type === 'node').map((e) => `${e.nodeId}:${e.status}`);
    assert.ok(statuses.includes('a:running') || statuses.includes('a:success'), statuses.join(' '));
    assert.equal(events.at(-1).status, 'SUCCESS', JSON.stringify(events.at(-1)));
    assert.equal(events.at(-1).output.c.output, '[mock] Summarize hello world'.length);
  });

  await step('save, list, load pipeline + run history', async () => {
    const created = await api('/api/pipelines', { method: 'POST', json: { name: 'Smoke', graph } });
    assert.equal(created.status, 201);
    const list = await api('/api/pipelines');
    assert.ok(list.body.pipelines.some((p: any) => p.id === created.body.pipeline.id));
    const loaded = await api(`/api/pipelines/${created.body.pipeline.id}`);
    assert.deepEqual(loaded.body.pipeline.graph.edges.length, 2);
    const run = await api(`/api/runs/${created.body.pipeline.id}`, { method: 'POST', json: { input: 'x' } });
    await stream(run.body.runId);
    const history = await api(`/api/runs?pipelineId=${created.body.pipeline.id}`);
    assert.equal(history.body.runs[0].status, 'SUCCESS');
  });

  await step('rejects cycles and other users’ data', async () => {
    const bad = await api('/api/runs', { method: 'POST', json: { graph: { nodes: graph.nodes, edges: [...graph.edges, { source: 'c', target: 'a' }] } } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /cycle/);
    const saved = token;
    token = '';
    assert.equal((await api('/api/pipelines')).status, 401);
    token = saved;
  });
}

if (want('p4')) {
  await step('template: save strips secrets, “Use this” clones with variables and runs', async () => {
    const tGraph = {
      nodes: [
        { id: 'n1', name: 'greet', type: 'llm', config: { prompt: 'Write a {{tone}} hello to {{input}}', apiKey: 'sk-secret' } },
        { id: 'n2', name: 'shout', type: 'transform', config: { expression: 'input.greet.output.toUpperCase()' } },
      ],
      edges: [{ source: 'n1', target: 'n2' }],
    };
    const t = await api('/api/templates', { method: 'POST', json: { name: 'Greeter', category: 'Marketing', public: true, graph: tGraph } });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.deepEqual(t.body.template.variables.map((v: any) => v.key), ['tone']);
    assert.equal(t.body.template.graph.nodes[0].config.apiKey, undefined);

    const gallery = await api('/api/templates');
    assert.ok(gallery.body.templates.some((x: any) => x.id === t.body.template.id));
    assert.equal((await api(`/api/templates/${t.body.template.id}/use`, { method: 'POST', json: { variables: {} } })).status, 400);

    const used = await api(`/api/templates/${t.body.template.id}/use`, { method: 'POST', json: { variables: { tone: 'cheerful' } } });
    assert.equal(used.status, 201);
    const p = used.body.pipeline;
    assert.ok(!p.graph.nodes.some((n: any) => n.id === 'n1'), 'node ids reassigned');
    const run = await api(`/api/runs/pipeline/${p.id}`, { method: 'POST', json: { input: 'Ada' } });
    const done = (await stream(run.body.runId)).at(-1);
    assert.equal(done.status, 'SUCCESS', JSON.stringify(done));
    assert.equal(done.output.shout.output, '[MOCK] WRITE A CHEERFUL HELLO TO ADA');
  });

  await step('knowledge base: upload a file, KB Query feeds the LLM', async () => {
    const form = new FormData();
    form.append('file', new Blob(['The office wifi password rotates every Monday. Ask the front desk for the new one.'], { type: 'text/plain' }), 'office.txt');
    const up = await api('/api/kb/upload', { method: 'POST', body: form });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const r = await api('/api/runs', {
      method: 'POST',
      json: {
        input: 'how do I get the wifi password',
        graph: {
          nodes: [
            { id: 'k', name: 'kbQuery', type: 'kbQuery', config: { query: '{{input}}' } },
            { id: 'l', name: 'answer', type: 'llm', config: { provider: 'mock', prompt: 'Using: {{kbQuery.output}}' } },
          ],
          edges: [{ source: 'k', target: 'l' }],
        },
      },
    });
    const done = (await stream(r.body.runId)).at(-1);
    assert.match(done.output.answer.output, /front desk/);
  });
}

if (want('p5')) {
  const { body: saved } = await api('/api/pipelines', { method: 'POST', json: { name: 'Deployed', graph: { nodes: [{ id: 'w', name: 'hook', type: 'webhook', config: {} }, { id: 'u', name: 'upper', type: 'transform', config: { expression: 'String(input.input.text).toUpperCase()' } }], edges: [{ source: 'w', target: 'u' }] } } });
  const pid = saved.pipeline.id;

  await step('webhook: rejects bad secrets, accepts secret or HMAC signature, runs async', async () => {
    const { body } = await api('/api/deployments', { method: 'POST', json: { pipelineId: pid, type: 'webhook' } });
    const d = body.deployment;
    const url = new URL(d.url).pathname;
    const payload = JSON.stringify({ text: 'hi' });
    const post = (headers: Record<string, string>) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
    assert.equal((await post({ 'x-webhook-secret': 'wrong' })).status, 401);
    assert.equal((await post({})).status, 401);

    const ok = await post({ 'x-webhook-secret': d.webhookSecret });
    assert.equal(ok.status, 202);
    const { runId } = await ok.json();
    const done = (await stream(runId)).at(-1);
    assert.equal(done.output.upper.output, 'HI');

    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', d.webhookSecret).update(payload).digest('hex');
    assert.equal((await post({ 'x-webhook-signature': `sha256=${sig}` })).status, 202);
    const runs = await api(`/api/deployments/${d.id}/runs`);
    assert.ok(runs.body.runs.length >= 1);
  });

  await step('REST API: synchronous invoke returns the final context', async () => {
    const { body } = await api('/api/deployments', { method: 'POST', json: { pipelineId: pid, type: 'api', syncTimeout: 10 } });
    const d = body.deployment;
    const res = await fetch(d.url.replace(/^https?:\/\/[^/]+/, BASE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': d.webhookSecret }, body: JSON.stringify({ text: 'sync' }) });
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.output.upper.output, 'SYNC');
  });

  await step('cron: validates expressions and registers the schedule', async () => {
    assert.equal((await api('/api/deployments', { method: 'POST', json: { pipelineId: pid, type: 'cron', cronExpression: 'not a cron' } })).status, 400);
    const c = await api('/api/deployments', { method: 'POST', json: { pipelineId: pid, type: 'cron', cronExpression: '* * * * *' } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    if (only.includes('cron')) {
      // Acceptance: wait for the scheduler to fire (up to ~70s).
      const until = Date.now() + 70_000;
      let runs: any[] = [];
      while (Date.now() < until && !runs.length) {
        await new Promise((r) => setTimeout(r, 3000));
        runs = (await api(`/api/deployments/${c.body.deployment.id}/runs`)).body.runs;
      }
      assert.ok(runs.length, 'cron run appeared in history');
      console.log(`  cron fired at ${runs[0].startedAt}`);
    }
    await api(`/api/deployments/${c.body.deployment.id}`, { method: 'PATCH', json: { active: false } });
  });

  await step('cancel stops a running run', async () => {
    const r = await api('/api/runs', { method: 'POST', json: { graph: { nodes: [{ id: 'd', type: 'delay', config: { duration: 5000 } }, { id: 't', type: 'transform', config: { expression: '1' } }], edges: [{ source: 'd', target: 't' }] } } });
    await new Promise((res) => setTimeout(res, 600));
    await api(`/api/runs/${r.body.runId}/cancel`, { method: 'POST' });
    const done = (await stream(r.body.runId)).at(-1);
    assert.equal(done.status, 'CANCELLED');
  });
}

console.log('smoke passed');
