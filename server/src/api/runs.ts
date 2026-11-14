import { Router, type Request, type Response } from 'express';
import { prisma, redis, newRedis, runChannel, CANCEL_CHANNEL } from '../db.ts';
import { HttpError, parseGraph } from './http.ts';
import { createRun, dailyBudget, tokensUsedToday, costPerMillion } from '../runs/create.ts';
import { ownPipeline } from './pipelines.ts';
import { runQueue } from '../queue.ts';
import { decide } from '../runs/approvals.ts';
import { accessPipeline, audit, visiblePipelines } from '../lib/access.ts';
import { Prisma } from '@prisma/client';

export const runsRouter = Router();

/** Your own runs, plus runs of team pipelines you can see ('edit' to cancel or decide approvals). */
async function ownRun(id: string, userId: string, need: 'view' | 'edit' = 'view') {
  const run = await prisma.run.findUnique({ where: { id }, include: { events: true } }).catch(() => null);
  if (!run) throw new HttpError(404, 'Run not found');
  if (run.userId === userId) return run;
  if (!run.pipelineId) throw new HttpError(404, 'Run not found');
  await accessPipeline(run.pipelineId, userId, need).catch((e) => {
    throw e.status === 403 ? e : new HttpError(404, 'Run not found');
  });
  return run;
}

// Run the canvas as-is (graph in body), optionally linked to a saved pipeline.
runsRouter.post('/', async (req, res) => {
  const p = req.body?.pipelineId ? await ownPipeline(req.body.pipelineId, req.userId) : null;
  const run = await createRun({ userId: req.userId, graph: parseGraph(req.body?.graph), input: req.body?.input, pipelineId: p?.id ?? null });
  await audit(req.userId, 'run.start', { teamId: p?.teamId, targetType: 'run', targetId: run.id, detail: { pipeline: p?.name ?? 'unsaved canvas' } });
  res.status(202).json({ runId: run.id });
});

// Run a saved pipeline by id: POST /api/runs/:pipelineId (the lifecycle diagram's route).
// /pipeline/:pipelineId is kept as an alias for existing callers.
runsRouter.post(['/:pipelineId', '/pipeline/:pipelineId'], async (req, res) => {
  const p = await ownPipeline(String(req.params.pipelineId), req.userId);
  const run = await createRun({ userId: req.userId, graph: parseGraph(p.graph), input: req.body?.input, pipelineId: p.id });
  await audit(req.userId, 'run.start', { teamId: p.teamId, targetType: 'run', targetId: run.id, detail: { pipeline: p.name } });
  res.status(202).json({ runId: run.id });
});

runsRouter.get('/', async (req, res) => {
  // For one pipeline: its whole history (team members see each other's runs). Otherwise: your runs.
  const pipelineId = req.query.pipelineId ? (await accessPipeline(String(req.query.pipelineId), req.userId, 'view')).id : null;
  const runs = await prisma.run.findMany({
    where: pipelineId ? { pipelineId } : { userId: req.userId },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: { id: true, pipelineId: true, deploymentId: true, status: true, error: true, tokensUsed: true, startedAt: true, finishedAt: true, pipeline: { select: { name: true } } },
  });
  res.json({ runs });
});

runsRouter.get('/:id', async (req, res) => {
  res.json({ run: await ownRun(req.params.id, req.userId) });
});

runsRouter.post('/:id/approval', async (req, res) => {
  const run = await ownRun(req.params.id, req.userId, 'edit');
  if (typeof req.body?.approved !== 'boolean') throw new HttpError(400, 'approved must be true or false');
  const result = await decide(run.id, req.body.approved, req.body.comment);
  const teamId = run.pipelineId ? (await prisma.pipeline.findUnique({ where: { id: run.pipelineId }, select: { teamId: true } }))?.teamId : null;
  await audit(req.userId, req.body.approved ? 'approval.approve' : 'approval.reject', { teamId, targetType: 'run', targetId: run.id });
  res.json(result);
});

runsRouter.post('/:id/cancel', async (req, res) => {
  const run = await ownRun(req.params.id, req.userId, 'edit');
  if (run.status === 'WAITING') {
    await prisma.run.update({ where: { id: run.id }, data: { status: 'CANCELLED', checkpoint: Prisma.DbNull, finishedAt: new Date() } });
    await redis.publish(runChannel(run.id), JSON.stringify({ type: 'done', status: 'CANCELLED' }));
  } else if (run.status === 'PENDING' && (await runQueue.remove(run.id))) {
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
      const e = JSON.parse(msg);
      if (e.type === 'done' && e.status !== 'WAITING') finish(); // a paused run resumes on this same stream
    });
    await sub.subscribe(runChannel(run.id));

    const fresh = await ownRun(run.id, req.userId);
    for (const e of fresh.events) send({ type: 'node', nodeId: e.nodeId, status: e.status, output: e.output, error: e.error, tokens: e.tokens });
    if (!['PENDING', 'RUNNING', 'WAITING'].includes(fresh.status)) {
      send({ type: 'done', status: fresh.status, error: fresh.error, output: fresh.output });
      finish();
    } else if (fresh.status === 'WAITING') {
      const cp = fresh.checkpoint as { nodeId: string; request: string } | null;
      send({ type: 'done', status: 'WAITING', waiting: cp && { nodeId: cp.nodeId, request: cp.request } });
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
    costPerMillion: costPerMillion(),
    days: rows.map((r) => ({ day: r.day, tokens: Number(r.tokens), runs: Number(r.runs) })),
  });
});

/**
 * Per-pipeline health over the last 14 days (pipelines you can see): runs, success rate,
 * average duration, tokens and cost; plus the latest failures so problems are easy to spot.
 */
usageRouter.get('/pipelines', async (req, res) => {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const visible = await prisma.pipeline.findMany({ where: visiblePipelines(req.userId), select: { id: true, name: true, team: { select: { name: true } } } });
  const ids = visible.map((p) => p.id);
  const rows = ids.length
    ? await prisma.$queryRaw<{ pipelineId: string; runs: bigint; ok: bigint; failed: bigint; tokens: bigint; avgMs: number | null }[]>`
        SELECT "pipelineId", COUNT(*) AS runs,
          COUNT(*) FILTER (WHERE status = 'SUCCESS') AS ok,
          COUNT(*) FILTER (WHERE status = 'ERROR') AS failed,
          COALESCE(SUM("tokensUsed"), 0) AS tokens,
          AVG(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt")) * 1000) FILTER (WHERE "finishedAt" IS NOT NULL) AS "avgMs"
        FROM "Run" WHERE "pipelineId" IN (${Prisma.join(ids)}) AND "startedAt" >= ${since}
        GROUP BY 1`
    : [];
  const price = costPerMillion();
  const byId = new Map(visible.map((p) => [p.id, p]));
  const failures = await prisma.run.findMany({
    where: { pipelineId: { in: ids }, status: 'ERROR', startedAt: { gte: since } },
    orderBy: { startedAt: 'desc' },
    take: 10,
    select: { id: true, pipelineId: true, error: true, startedAt: true, deploymentId: true },
  });
  res.json({
    costPerMillion: price,
    pipelines: rows
      .map((r) => {
        const tokens = Number(r.tokens);
        return {
          pipelineId: r.pipelineId,
          name: byId.get(r.pipelineId)?.name,
          team: byId.get(r.pipelineId)?.team?.name ?? null,
          runs: Number(r.runs),
          successRate: Number(r.runs) ? Number(r.ok) / Number(r.runs) : 0,
          failed: Number(r.failed),
          avgMs: r.avgMs === null ? null : Math.round(r.avgMs),
          tokens,
          cost: price ? (tokens / 1_000_000) * price : null,
        };
      })
      .sort((a, b) => b.tokens - a.tokens || b.runs - a.runs),
    failures: failures.map((f) => ({ ...f, name: byId.get(f.pipelineId!)?.name })),
  });
});
