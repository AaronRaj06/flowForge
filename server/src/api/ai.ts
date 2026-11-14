import { Router } from 'express';
import { HttpError } from './http.ts';
import { handlers } from '../engine/nodes/index.ts';
import { generatePipeline, suggestFix } from '../ai/assist.ts';

export const aiRouter = Router();

aiRouter.post('/generate', async (req, res) => {
  const description = String(req.body?.description ?? '').trim();
  if (description.length < 5) throw new HttpError(400, 'Describe what the pipeline should do');
  if (description.length > 2000) throw new HttpError(400, 'Keep the description under 2,000 characters');
  res.json({ graph: await generatePipeline(req.userId, description) });
});

aiRouter.post('/fix', async (req, res) => {
  const { node, error } = req.body ?? {};
  if (!node || typeof node.type !== 'string' || !handlers[node.type]) throw new HttpError(400, 'node.type must be a known block type');
  if (node.config != null && (typeof node.config !== 'object' || Array.isArray(node.config))) throw new HttpError(400, 'node.config must be an object');
  if (typeof error !== 'string' || !error.trim()) throw new HttpError(400, 'error is required');
  res.json(await suggestFix(req.userId, { type: node.type, name: typeof node.name === 'string' ? node.name : undefined, config: node.config ?? {} }, error.slice(0, 4000)));
});
