import { Worker } from 'bullmq';
import { prisma, newRedis, CANCEL_CHANNEL } from './db.ts';
import { QUEUE_NAME, scheduleCron, type CronJob, type RunJob } from './queue.ts';
import { executeRun } from './runs/execute.ts';

const active = new Map<string, AbortController>();

async function runWithAbort(runId: string) {
  const ac = new AbortController();
  active.set(runId, ac);
  try {
    return await executeRun(runId, ac.signal);
  } finally {
    active.delete(runId);
  }
}

const cancelSub = newRedis();
await cancelSub.subscribe(CANCEL_CHANNEL);
cancelSub.on('message', (_ch, runId) => active.get(runId)?.abort(new Error('Cancelled')));

async function startCronRun(deploymentId: string) {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { pipeline: true } });
  if (!dep?.active) return; // deactivated after scheduling; the scheduler is removed on update
  const run = await prisma.run.create({
    data: { userId: dep.userId, pipelineId: dep.pipelineId, deploymentId, graph: dep.pipeline.graph as object, input: { triggeredAt: new Date().toISOString() } },
  });
  await prisma.deployment.update({ where: { id: deploymentId }, data: { lastRunAt: new Date() } });
  return runWithAbort(run.id);
}

const worker = new Worker<RunJob | CronJob>(
  QUEUE_NAME,
  async (job) => {
    const res = job.data.kind === 'cron' ? await startCronRun(job.data.deploymentId) : await runWithAbort(job.data.runId);
    return { runId: res?.id, status: res?.status };
  },
  { connection: newRedis(), concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5) },
);

worker.on('failed', (job, err) => console.error(`job ${job?.id} failed:`, err.message));

// Re-register every active cron deployment on startup (upsert is idempotent).
const crons = await prisma.deployment.findMany({ where: { type: 'cron', active: true } });
for (const d of crons) await scheduleCron(d.id, d.cronExpression!);
console.log(`worker ready (${crons.length} cron deployment${crons.length === 1 ? '' : 's'} scheduled)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
