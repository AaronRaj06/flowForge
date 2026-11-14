import { Router } from 'express';
import { prisma } from '../db.ts';
import cronParser from 'cron-parser';
import { HttpError, parseGraph } from './http.ts';
import { costPerMillion } from '../runs/create.ts';

/** How many times a cron expression fires in the next 30 days (capped, for every-minute schedules). */
export function runsPerMonth(expr: string, cap = 50_000) {
  const end = new Date(Date.now() + 30 * 86_400_000);
  const it = cronParser.parseExpression(expr, { currentDate: new Date(), endDate: end });
  let n = 0;
  while (n < cap && it.hasNext()) (it.next(), n++);
  return n;
}

export const pipelinesRouter = Router();

export async function ownPipeline(id: string, userId: string) {
  const p = await prisma.pipeline.findFirst({ where: { id, userId } });
  if (!p) throw new HttpError(404, 'Pipeline not found');
  return p;
}

pipelinesRouter.get('/', async (req, res) => {
  const pipelines = await prisma.pipeline.findMany({
    where: { userId: req.userId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, name: true, description: true, errorPipelineId: true, updatedAt: true, createdAt: true },
  });
  res.json({ pipelines });
});

pipelinesRouter.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').trim() || 'Untitled pipeline';
  const pipeline = await prisma.pipeline.create({
    data: { userId: req.userId, name, description: req.body?.description ?? null, graph: parseGraph(req.body?.graph) as object },
  });
  res.status(201).json({ pipeline });
});

pipelinesRouter.get('/:id', async (req, res) => {
  res.json({ pipeline: await ownPipeline(req.params.id, req.userId) });
});

pipelinesRouter.put('/:id', async (req, res) => {
  await ownPipeline(req.params.id, req.userId);
  const data: Record<string, unknown> = {};
  if (req.body?.name !== undefined) data.name = String(req.body.name).trim() || 'Untitled pipeline';
  if (req.body?.description !== undefined) data.description = req.body.description;
  if (req.body?.graph !== undefined) data.graph = parseGraph(req.body.graph);
  if (req.body?.maxTokensPerRun !== undefined) {
    const v = req.body.maxTokensPerRun;
    if (v === null || v === '') data.maxTokensPerRun = null;
    else if (!Number.isInteger(v) || v < 100 || v > 10_000_000) throw new HttpError(400, 'maxTokensPerRun must be a whole number from 100 to 10,000,000');
    else data.maxTokensPerRun = v;
  }
  if (req.body?.errorPipelineId !== undefined) {
    const target = req.body.errorPipelineId;
    if (target === null || target === '') data.errorPipelineId = null;
    else {
      if (target === req.params.id) throw new HttpError(400, 'A pipeline can’t be its own error workflow');
      data.errorPipelineId = (await ownPipeline(String(target), req.userId)).id;
    }
  }
  res.json({ pipeline: await prisma.pipeline.update({ where: { id: req.params.id }, data }) });
});

// Cost from history: average tokens per run and per block over the last 20 successful runs,
// projected over each active schedule.
pipelinesRouter.get('/:id/cost', async (req, res) => {
  const p = await ownPipeline(req.params.id, req.userId);
  const runs = await prisma.run.findMany({
    where: { pipelineId: p.id, status: 'SUCCESS' },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: { tokensUsed: true, events: { select: { nodeId: true, tokens: true } } },
  });
  const n = runs.length;
  const perNode = new Map<string, number>();
  for (const r of runs) for (const e of r.events) perNode.set(e.nodeId, (perNode.get(e.nodeId) ?? 0) + e.tokens);
  const avgPerRun = n ? Math.round(runs.reduce((s, r) => s + r.tokensUsed, 0) / n) : 0;
  const crons = await prisma.deployment.findMany({ where: { pipelineId: p.id, type: 'cron', active: true } });
  res.json({
    sampleRuns: n,
    avgTokensPerRun: avgPerRun,
    perNode: Object.fromEntries([...perNode].filter(([, t]) => t > 0).map(([id, t]) => [id, Math.round(t / n)])),
    schedules: crons.map((d) => {
      const perMonth = runsPerMonth(d.cronExpression!);
      return { deploymentId: d.id, cronExpression: d.cronExpression, runsPerMonth: perMonth, tokensPerMonth: perMonth * avgPerRun };
    }),
    maxTokensPerRun: p.maxTokensPerRun,
    costPerMillion: costPerMillion(),
  });
});

pipelinesRouter.delete('/:id', async (req, res) => {
  await ownPipeline(req.params.id, req.userId);
  await prisma.pipeline.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
