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
    const out = events.at(-1).output;
    assert.equal(out.c.output, out.summary.output.length);
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
    const t = await api('/api/templates', { method: 'POST', json: { name: 'Greeter', category: 'Marketing', public: false, graph: tGraph } });
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
    assert.equal(done.output.shout.output, done.output.greet.output.toUpperCase());
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

if (want('p6')) {
  await step('loop runs its body per item; merge collects; retries + continue on fail', async () => {
    const r = await api('/api/runs', {
      method: 'POST',
      json: {
        input: { names: ['Ada', 'Lin', 'Kay'] },
        graph: {
          nodes: [
            { id: 'L', name: 'each', type: 'loop', config: { items: 'input.input.names' } },
            { id: 'G', name: 'greet', type: 'transform', config: { expression: 'input.item.toUpperCase()' } },
            { id: 'M', name: 'all', type: 'merge', config: {} },
            { id: 'F', name: 'flaky', type: 'transform', config: { expression: 'input.nope.x', retries: 1, retryDelayMs: 10, continueOnFail: true } },
          ],
          edges: [{ source: 'L', target: 'G' }, { source: 'G', target: 'M' }, { source: 'M', target: 'F' }],
        },
      },
    });
    const done = (await stream(r.body.runId)).at(-1);
    assert.equal(done.status, 'SUCCESS', JSON.stringify(done));
    assert.deepEqual(done.output.all.output, ['ADA', 'LIN', 'KAY']);
    assert.match(done.output.flaky.error, /after 2 attempts/);
  });

  await step('error workflow starts when a pipeline fails, with the failure as input', async () => {
    const handler = await api('/api/pipelines', { method: 'POST', json: { name: 'on-fail', graph: { nodes: [{ id: 'h', name: 'note', type: 'transform', config: { expression: '"failed: " + input.input.failedRun.pipelineName' } }], edges: [] } } });
    const broken = await api('/api/pipelines', { method: 'POST', json: { name: 'broken', graph: { nodes: [{ id: 'b', type: 'transform', config: { expression: 'input.nope.x' } }], edges: [] } } });
    const self = await api(`/api/pipelines/${broken.body.pipeline.id}`, { method: 'PUT', json: { errorPipelineId: broken.body.pipeline.id } });
    assert.equal(self.status, 400);
    const set = await api(`/api/pipelines/${broken.body.pipeline.id}`, { method: 'PUT', json: { errorPipelineId: handler.body.pipeline.id } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const r = await api(`/api/runs/${broken.body.pipeline.id}`, { method: 'POST', json: {} });
    assert.equal((await stream(r.body.runId)).at(-1).status, 'ERROR');
    let handled: any;
    for (let i = 0; i < 40 && !handled; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const runs = (await api(`/api/runs?pipelineId=${handler.body.pipeline.id}`)).body.runs;
      if (runs[0]?.status === 'SUCCESS') handled = (await api(`/api/runs/${runs[0].id}`)).body.run;
    }
    assert.ok(handled, 'error workflow never ran');
    assert.equal(handled.output.note.output, 'failed: broken');
    assert.equal(handled.input.failedRun.failedNodeId, 'b');
  });
}

if (want('p7')) {
  await step('cost: per-block tokens, schedule projection, and a per-run token limit', async () => {
    const graph = {
      nodes: [
        { id: 'a', name: 'first', type: 'llm', config: { provider: 'mock', prompt: 'x'.repeat(400) } },
        { id: 'b', name: 'second', type: 'llm', config: { provider: 'mock', prompt: 'again {{first.output}}' } },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const p = (await api('/api/pipelines', { method: 'POST', json: { name: 'costly', graph } })).body.pipeline;
    for (let i = 0; i < 2; i++) {
      const r = await api(`/api/runs/${p.id}`, { method: 'POST', json: {} });
      assert.equal((await stream(r.body.runId)).at(-1).status, 'SUCCESS');
    }
    const dep = await api('/api/deployments', { method: 'POST', json: { pipelineId: p.id, type: 'cron', cronExpression: '0 9 * * *' } });
    const cost = (await api(`/api/pipelines/${p.id}/cost`)).body;
    assert.equal(cost.sampleRuns, 2);
    assert.ok(cost.perNode.a > 100 && cost.perNode.b > 0, JSON.stringify(cost));
    assert.equal(cost.avgTokensPerRun, cost.perNode.a + cost.perNode.b);
    assert.ok(cost.schedules[0].runsPerMonth >= 29, JSON.stringify(cost.schedules));
    await api(`/api/deployments/${dep.body.deployment.id}`, { method: 'PATCH', json: { active: false } });

    assert.equal((await api(`/api/pipelines/${p.id}`, { method: 'PUT', json: { maxTokensPerRun: 5 } })).status, 400);
    assert.equal((await api(`/api/pipelines/${p.id}`, { method: 'PUT', json: { maxTokensPerRun: 100 } })).status, 200);
    const r = await api(`/api/runs/${p.id}`, { method: 'POST', json: {} });
    const done = (await stream(r.body.runId)).at(-1);
    assert.equal(done.status, 'ERROR');
    assert.match(done.error, /Token limit reached/);
    const row = (await api(`/api/runs/${r.body.runId}`)).body.run;
    assert.ok(row.tokensUsed > 100, 'tokens of a failed run must still be billed');
  });
}

if (want('p8')) {
  await step('p8: approval pauses a run, the decision resumes it on the right branch, and agents run', async () => {
    const graph = {
      nodes: [
        { id: 'a', name: 'draft', type: 'llm', config: { provider: 'mock', prompt: 'Reply to {{input}}' } },
        { id: 'b', name: 'gate', type: 'approval', config: { message: 'Send {{draft.output}}?' } },
        { id: 'c', name: 'sent', type: 'transform', config: { expression: '"sent: " + input.gate.output.comment' } },
        { id: 'd', name: 'held', type: 'transform', config: { expression: '"held"' } },
        { id: 'e', name: 'helper', type: 'agent', config: { provider: 'mock', prompt: 'Summarise {{sent.output}}', tools: ['http'] } },
      ],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c', sourceHandle: 'true' }, { source: 'b', target: 'd', sourceHandle: 'false' }, { source: 'c', target: 'e' }],
    };
    const p = (await api('/api/pipelines', { method: 'POST', json: { name: 'approve me', graph } })).body.pipeline;
    const r = await api(`/api/runs/${p.id}`, { method: 'POST', json: { input: 'Ada' } });
    const paused = (await stream(r.body.runId)).at(-1);
    assert.equal(paused.status, 'WAITING', JSON.stringify(paused));
    assert.equal(paused.waiting.request, 'Send [mock] Reply to Ada?');
    const before = (await api(`/api/runs/${r.body.runId}`)).body.run;
    assert.ok(before.tokensUsed > 0);

    assert.equal((await api(`/api/runs/${r.body.runId}/approval`, { method: 'POST', json: { approved: 'yes' } })).status, 400);
    assert.equal((await api(`/api/runs/${r.body.runId}/approval`, { method: 'POST', json: { approved: true, comment: 'ok' } })).status, 200);
    assert.equal((await api(`/api/runs/${r.body.runId}/approval`, { method: 'POST', json: { approved: false } })).status, 409, 'only the first decision counts');
    const done = (await stream(r.body.runId)).at(-1);
    assert.equal(done.status, 'SUCCESS', JSON.stringify(done));
    assert.equal(done.output.sent.output, 'sent: ok');
    assert.equal(done.output.held, undefined);
    assert.match(done.output.helper.output.answer, /^\[mock\]/);
    const after = (await api(`/api/runs/${r.body.runId}`)).body.run;
    assert.ok(after.tokensUsed > before.tokensUsed, 'tokens from before and after the pause add up');
    assert.equal(after.events.find((e: any) => e.nodeId === 'd').status, 'skipped');

    // A waiting run can be cancelled.
    const r2 = await api(`/api/runs/${p.id}`, { method: 'POST', json: { input: 'Bob' } });
    assert.equal((await stream(r2.body.runId)).at(-1).status, 'WAITING');
    await api(`/api/runs/${r2.body.runId}/cancel`, { method: 'POST' });
    assert.equal((await api(`/api/runs/${r2.body.runId}`)).body.run.status, 'CANCELLED');
  });
}

if (want('p9')) {
  await step('p9: credentials hide secrets; form trigger starts runs with fields and a file', async () => {
    assert.equal((await api('/api/credentials', { method: 'POST', json: { name: 'gh', type: 'github', secret: 'not-a-token' } })).status, 400);
    const c = await api('/api/credentials', { method: 'POST', json: { name: 'gh', type: 'github', secret: 'ghp_' + 'x'.repeat(30) } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await api('/api/credentials', { method: 'POST', json: { name: 'gh', type: 'github', secret: 'ghp_' + 'y'.repeat(30) } })).status, 409);
    const list = await api('/api/credentials');
    assert.ok(!JSON.stringify(list.body).includes('xxxx'), 'secrets never come back');
    assert.equal(list.body.credentials[0].name, 'gh');

    const graph = { nodes: [{ id: 'a', name: 'shout', type: 'transform', config: { expression: 'input.input.Name.toUpperCase() + " " + input.input.file.text' } }], edges: [] };
    const p = (await api('/api/pipelines', { method: 'POST', json: { name: 'Contact form', graph } })).body.pipeline;
    assert.equal((await api('/api/deployments', { method: 'POST', json: { pipelineId: p.id, type: 'form', formFields: '' } })).status, 400);
    const d = (await api('/api/deployments', { method: 'POST', json: { pipelineId: p.id, type: 'form', formFields: 'Name, Message', formFile: true } })).body.deployment;
    assert.equal(d.webhookSecret, null);
    const page = await fetch(d.url);
    assert.match(await page.text(), /<label for="f0">Name<\/label>/);
    const fd = new FormData();
    fd.set('Name', 'ada');
    fd.set('Message', 'hello');
    fd.set('file', new Blob(['file body'], { type: 'text/plain' }), 'note.txt');
    const sub = await fetch(d.url, { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    assert.equal(sub.status, 202);
    const done = (await stream((await sub.json()).runId)).at(-1);
    assert.equal(done.output.shout.output, 'ADA file body');
    await api(`/api/credentials/${c.body.credential.id}`, { method: 'DELETE' });
  });
}

if (want('p10')) {
  await step('p10: teams share pipelines by role, enforce a team quota, and keep an audit log', async () => {
    const me = token;
    const register = async (tag: string) => {
      const email = `smoke-${tag}-${Date.now()}@flowforge.dev`;
      const r = await api('/api/auth/register', { method: 'POST', json: { email, password: 'password123' } });
      return { email, token: r.body.token as string };
    };
    const editor = await register('editor');
    const viewer = await register('viewer');
    const outsider = await register('outsider');
    const as = async <T>(t: string, fn: () => Promise<T>) => {
      token = t;
      try {
        return await fn();
      } finally {
        token = me;
      }
    };

    const team = (await api('/api/teams', { method: 'POST', json: { name: 'Ops' } })).body.team;
    assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', json: { email: editor.email, role: 'editor' } })).status, 201);
    assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', json: { email: viewer.email, role: 'viewer' } })).status, 201);
    assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', json: { email: 'nobody@nowhere.dev' } })).status, 404);

    const graph = { nodes: [{ id: 'a', name: 'big', type: 'llm', config: { provider: 'mock', prompt: 'x'.repeat(4000) } }], edges: [] };
    const p = (await api('/api/pipelines', { method: 'POST', json: { name: 'Team pipe', graph, teamId: team.id } })).body.pipeline;

    // Visibility and roles.
    await as(viewer.token, async () => {
      const list = await api('/api/pipelines');
      assert.equal(list.body.pipelines.find((x: any) => x.id === p.id)?.role, 'viewer');
      assert.equal((await api(`/api/pipelines/${p.id}`)).status, 200);
      assert.equal((await api(`/api/pipelines/${p.id}`, { method: 'PUT', json: { name: 'hacked' } })).status, 403);
      assert.equal((await api(`/api/runs/${p.id}`, { method: 'POST', json: {} })).status, 403);
      assert.equal((await api(`/api/deployments?pipelineId=${p.id}`)).status, 403, 'viewers never see webhook secrets');
      assert.equal((await api(`/api/teams/${team.id}/members`, { method: 'POST', json: { email: outsider.email } })).status, 403);
    });
    await as(outsider.token, async () => {
      assert.equal((await api(`/api/pipelines/${p.id}`)).status, 404);
      assert.equal((await api(`/api/teams/${team.id}`)).status, 404);
      assert.equal((await api(`/api/audit?teamId=${team.id}`)).status, 404);
    });
    const run = await as(editor.token, async () => {
      assert.equal((await api(`/api/pipelines/${p.id}`, { method: 'PUT', json: { name: 'Team pipe v2' } })).status, 200);
      const r = await api(`/api/runs/${p.id}`, { method: 'POST', json: {} });
      assert.equal(r.status, 202);
      assert.equal((await stream(r.body.runId)).at(-1).status, 'SUCCESS');
      return r.body.runId;
    });
    // The owner and the viewer both see the editor's run in the pipeline's history.
    assert.ok((await api(`/api/runs?pipelineId=${p.id}`)).body.runs.some((r: any) => r.id === run));
    assert.equal(await as(viewer.token, async () => (await api(`/api/runs/${run}`)).status), 200);
    assert.equal(await as(outsider.token, async () => (await api(`/api/runs/${run}`)).status), 404);

    // Team quota: the editor's run used >1,000 tokens, so the next one is refused for everyone.
    assert.equal((await api(`/api/teams/${team.id}`, { method: 'PATCH', json: { dailyTokenBudget: 1000 } })).status, 200);
    const over = await api(`/api/runs/${p.id}`, { method: 'POST', json: {} });
    assert.equal(over.status, 429);
    assert.match(over.body.error, /Team “Ops” has used its daily token budget/);
    const t = (await api(`/api/teams/${team.id}`)).body.team;
    assert.ok(t.tokensToday >= 1000 && t.members.length === 3, JSON.stringify(t));

    // Owner rules.
    assert.equal((await api(`/api/teams/${team.id}/members/${t.members[0].userId}`, { method: 'DELETE' })).status, 400, 'the last owner can’t leave');
    assert.equal((await api(`/api/teams/${team.id}/members/${t.members[1].userId}`, { method: 'PATCH', json: { role: 'viewer' } })).status, 200);
    assert.equal(await as(editor.token, async () => (await api(`/api/pipelines/${p.id}`, { method: 'PUT', json: { name: 'x' } })).status), 403, 'demoted to viewer');

    // Audit log, newest first.
    const actions = (await api(`/api/audit?teamId=${team.id}`)).body.events.map((e: any) => `${e.action}:${e.by.split('-')[1]}`);
    for (const a of ['member.role', 'team.update', 'run.start', 'pipeline.update', 'pipeline.create', 'member.add', 'team.create']) {
      assert.ok(actions.some((x: string) => x.startsWith(a)), `${a} missing from ${actions.join(' ')}`);
    }
    assert.ok(actions.includes('pipeline.update:editor'), 'events record who did it');

    // Deleting the team hands its pipelines back to their creators.
    assert.equal((await api(`/api/teams/${team.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/pipelines/${p.id}`)).body.pipeline.teamId, null);
    assert.equal(await as(viewer.token, async () => (await api(`/api/pipelines/${p.id}`)).status), 404);

    // Observability: per-pipeline metrics and recent failures.
    const m = (await api('/api/usage/pipelines')).body;
    assert.ok(Array.isArray(m.pipelines) && Array.isArray(m.failures));
    assert.ok(m.pipelines.some((x: any) => x.pipelineId === p.id && x.runs >= 1 && x.successRate === 1), JSON.stringify(m.pipelines));
  });
}

console.log('smoke passed');
