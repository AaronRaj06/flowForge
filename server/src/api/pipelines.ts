import { Router } from 'express';
import { prisma } from '../db.ts';
import { HttpError, parseGraph } from './http.ts';

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
    select: { id: true, name: true, description: true, updatedAt: true, createdAt: true },
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
  res.json({ pipeline: await prisma.pipeline.update({ where: { id: req.params.id }, data }) });
});

pipelinesRouter.delete('/:id', async (req, res) => {
  await ownPipeline(req.params.id, req.userId);
  await prisma.pipeline.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
