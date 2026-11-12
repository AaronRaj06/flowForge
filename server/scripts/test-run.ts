// Phase 1 smoke test: LLM → HTTP → LLM, executed directly (no queue), events written to Postgres.
// Usage: npm run test-run            (normal order)
//        npm run test-run -- --swap  (LLM nodes swapped)
//        npm run test-run -- --cycle (adds n3 → n1, must throw CyclicDependencyError)
import { prisma, redis } from '../src/db.ts';
import { executeRun } from '../src/runs/execute.ts';
import { runPipeline } from '../src/engine/runner.ts';
import type { Graph } from '../src/engine/types.ts';

const args = process.argv.slice(2);
const graph: Graph = {
  nodes: [
    { id: 'n1', type: 'llm', config: { prompt: 'Summarize: {{input}}' } },
    { id: 'n2', type: 'http', config: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1' } },
    { id: 'n3', type: 'llm', config: { prompt: 'Translate to Spanish: {{n1.output}} (todo: {{n2.output.title}})' } },
  ],
  edges: [
    { source: 'n1', target: 'n2' },
    { source: 'n2', target: 'n3' },
  ],
};

if (args.includes('--swap')) {
  // Reverse the chain: translate first, then summarize the translation.
  graph.nodes[2].config.prompt = 'Translate to Spanish: {{input}}';
  graph.nodes[0].config.prompt = 'Summarize: {{n3.output}} (todo: {{n2.output.title}})';
  graph.edges = [{ source: 'n3', target: 'n2' }, { source: 'n2', target: 'n1' }];
}
if (args.includes('--cycle')) graph.edges.push({ source: 'n3', target: 'n1' });

const input = 'The quick brown fox jumps over the lazy dog.';

try {
  if (args.includes('--cycle')) {
    await runPipeline(graph, input);
  } else {
    const user = await prisma.user.upsert({
      where: { email: 'demo@flowforge.dev' },
      create: { email: 'demo@flowforge.dev', passwordHash: '!' },
      update: {},
    });
    const run = await prisma.run.create({ data: { userId: user.id, graph, input } });
    const done = await executeRun(run.id);
    const events = await prisma.runEvent.findMany({ where: { runId: run.id }, orderBy: { startedAt: 'asc' } });
    console.log('status:', done.status, done.error ?? '');
    console.log('events:', events.map((e) => `${e.nodeId}=${e.status}`).join(' '));
    console.log('final context:', JSON.stringify(done.output, null, 2));
    if (done.status !== 'SUCCESS') process.exitCode = 1;
  }
} catch (err) {
  console.error(`${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  redis.disconnect();
}
