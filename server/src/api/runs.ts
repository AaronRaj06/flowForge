import { Router, type Request, type Response } from 'express';
import { prisma, redis, newRedis, runChannel, CANCEL_CHANNEL } from '../db.ts';
import { HttpError, parseGraph } from './http.ts';
import { createRun, dailyBudget, tokensUsedToday } from '../runs/create.ts';
import { ownPipeline } from './pipelines.ts';
import { runQueue } from '../queue.ts';

export const runsRouter = Router();

async function ownRun(id: string, userId: string) {
  const run = await prisma.run.findFirst({
    where: { id, userId },
    include: { events: true },
  });
  if (!run) throw new HttpError(404, 'Run not found');
  return run;
}

// Run the canvas as-is (graph in body), optionally linked to a saved pipeline.
runsRouter.post('/', async (req, res) => {
  const pipelineId = req.body?.pipelineId ? (await ownPipeline(req.body.pipelineId, req.userId)).id : null;
  const run = await createRun({ userId: req.userId, graph: parseGraph(req.body?.graph), input: req.body?.input, pipelineId });
  res.status(202).json({ runId: run.id });
});

// Run a saved pipeline by id: POST /api/runs/:pipelineId (the lifecycle diagram's route).
// /pipeline/:pipelineId is kept as an alias for existing callers.
runsRouter.post(['/:pipelineId', '/pipeline/:pipelineId'], async (req, res) => {
  const p = await ownPipeline(req.params.pipelineId, req.userId);
  const run = await createRun({ userId: req.userId, graph: parseGraph(p.graph), input: req.body?.input, pipelineId: p.id });
  res.status(202).json({ runId: run.id });
});

runsRouter.get('/', async (req, res) => {
  const runs = await prisma.run.findMany({
    where: { userId: req.userId, ...(req.query.pipelineId ? { pipelineId: String(req.query.pipelineId) } : {}) },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: { id: true, pipelineId: true, deploymentId: true, status: true, error: true, tokensUsed: true, startedAt: true, finishedAt: true, pipeline: { select: { name: true } } },
  });
  res.json({ runs });
});

runsRouter.get('/:id', async (req, res) => {
  res.json({ run: await ownRun(req.params.id, req.userId) });
});

runsRouter.post('/:id/cancel', async (req, res) => {
  const run = await ownRun(req.params.id, req.userId);
  if (run.status === 'PENDING' && (await runQueue.remove(run.id))) {
    await prisma.run.update({ where: { id: run.id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    await redis.publish(runChannel(run.id), JSON.stringify({ type: 'done', status: 'CANCELLED' }));
  } else if (run.status === 'PENDING' || run.status === 'RUNNING') {
    await redis.publish(CANCEL_CHANNEL, run.id); // the worker aborts it between nodes
  }
  res.json({ ok: true });
});

/**
 * SSE: subscribe first, then send the stored snapshot, so no event can fall in the gap.
 * The connection always closes when the run finishes, errors, or the client leaves.
 */
export async function streamRun(req: Request, res: Response) {
  const run = await ownRun(String(req.params.id), req.userId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const sub = newRedis();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  let finish: () => void = () => {};
  const closed = new Promise<void>((r) => (finish = r));
  req.on('close', finish);

  try {
    sub.on('message', (_ch, msg) => {
      res.write(`data: ${msg}\n\n`);
      if (JSON.parse(msg).type === 'done') finish();
    });
    await sub.subscribe(runChannel(run.id));

    const fresh = await ownRun(run.id, req.userId);
    for (const e of fresh.events) send({ type: 'node', nodeId: e.nodeId, status: e.status, output: e.output, error: e.error });
    if (!['PENDING', 'RUNNING'].includes(fresh.status)) {
      send({ type: 'done', status: fresh.status, error: fresh.error, output: fresh.output });
      finish();
    }
    await closed;
  } finally {
    clearInterval(heartbeat);
    sub.disconnect();
    res.end();
  }
}

export const usageRouter = Router();

usageRouter.get('/', async (req, res) => {
  const since = new Date(Date.now() - 13 * 86_400_000);
  since.setHours(0, 0, 0, 0);
  const rows = await prisma.$queryRaw<{ day: Date; tokens: bigint; runs: bigint }[]>`
    SELECT date_trunc('day', "startedAt") AS day, SUM("tokensUsed") AS tokens, COUNT(*) AS runs
    FROM "Run" WHERE "userId" = ${req.userId} AND "startedAt" >= ${since}
    GROUP BY 1 ORDER BY 1`;
  res.json({
    today: await tokensUsedToday(req.userId),
    budget: dailyBudget(),
    days: rows.map((r) => ({ day: r.day, tokens: Number(r.tokens), runs: Number(r.runs) })),
  });
});
