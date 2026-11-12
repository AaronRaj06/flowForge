import { Router } from 'express';
import { prisma } from '../db.ts';
import { HttpError, parseGraph } from './http.ts';
import { cloneGraph } from '../lib/cloneGraph.ts';
import { extractVariables, fillVariables, stripSecrets, type TemplateVariable } from '../lib/templates.ts';
import type { Graph } from '../engine/types.ts';

export const templatesRouter = Router();

const CATEGORIES = ['Productivity', 'Marketing', 'Dev', 'Other'];

templatesRouter.get('/', async (req, res) => {
  const rows = await prisma.template.findMany({
    where: { OR: [{ public: true }, { authorId: req.userId }] },
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { email: true } } },
  });
  res.json({
    templates: rows.map(({ graph, ...t }) => ({ ...t, nodeCount: (graph as unknown as Graph).nodes.length })),
  });
});

templatesRouter.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Template needs a name');
  const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'Other';
  const graph = stripSecrets(parseGraph(req.body?.graph));
  const template = await prisma.template.create({
    data: {
      authorId: req.userId,
      name,
      description: req.body?.description || null,
      category,
      public: !!req.body?.public,
      graph: graph as object,
      variables: extractVariables(graph) as object[],
    },
  });
  res.status(201).json({ template });
});

templatesRouter.post('/:id/use', async (req, res) => {
  const t = await prisma.template.findFirst({ where: { id: req.params.id, OR: [{ public: true }, { authorId: req.userId }] } });
  if (!t) throw new HttpError(404, 'Template not found');
  const values: Record<string, string> = req.body?.variables ?? {};
  const missing = (t.variables as TemplateVariable[]).filter((v) => !String(values[v.key] ?? v.defaultValue ?? '').trim());
  if (missing.length) throw new HttpError(400, `Fill in: ${missing.map((v) => v.key).join(', ')}`);
  const filled = Object.fromEntries((t.variables as TemplateVariable[]).map((v) => [v.key, String(values[v.key] ?? v.defaultValue)]));

  const graph = fillVariables(cloneGraph(t.graph as unknown as Graph), filled);
  const pipeline = await prisma.pipeline.create({
    data: { userId: req.userId, name: t.name, description: t.description, graph: parseGraph(graph) as object },
  });
  res.status(201).json({ pipeline });
});

templatesRouter.delete('/:id', async (req, res) => {
  const { count } = await prisma.template.deleteMany({ where: { id: req.params.id, authorId: req.userId } });
  if (!count) throw new HttpError(404, 'Template not found');
  res.status(204).end();
});
