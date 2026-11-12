import { Router, type Request } from 'express';
import { randomBytes } from 'node:crypto';
import cronParser from 'cron-parser';
import type { Deployment } from '@prisma/client';
import { prisma, redis, newRedis, runChannel } from '../db.ts';
import { HttpError, parseGraph } from './http.ts';
import { ownPipeline } from './pipelines.ts';
import { scheduleCron, unscheduleCron, enqueueRun } from '../queue.ts';
import { createRun } from '../runs/create.ts';
import { safeEqual, hmacHex } from '../lib/crypto.ts';

export const deploymentsRouter = Router();
const TYPES = ['cron', 'webhook', 'api'] as const;
const MIN_CRON_INTERVAL_MS = 60_000;

const publicUrl = () => process.env.PUBLIC_URL ?? 'http://localhost:4000';
const present = (d: Deployment) => ({
  ...d,
  url: d.type === 'webhook' ? `${publicUrl()}/webhooks/${d.id}` : d.type === 'api' ? `${publicUrl()}/api/${d.id}/invoke` : undefined,
});

function validateCron(expr: unknown): string {
  const e = String(expr ?? '').trim();
  if (e.split(/\s+/).length !== 5) throw new HttpError(400, 'Use a 5-field cron expression, e.g. "0 9 * * 1-5"');
  try {
    const it = cronParser.parseExpression(e);
    const a = it.next().getTime();
    const b = it.next().getTime();
    if (b - a < MIN_CRON_INTERVAL_MS) throw new HttpError(400, 'Schedules can run at most once a minute');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, `Invalid cron expression: ${(err as Error).message}`);
  }
  return e;
}

async function ownDeployment(id: string, userId: string) {
  const d = await prisma.deployment.findFirst({ where: { id, userId } });
  if (!d) throw new HttpError(404, 'Deployment not found');
  return d;
}

deploymentsRouter.get('/', async (req, res) => {
  const deployments = await prisma.deployment.findMany({
    where: { userId: req.userId, ...(req.query.pipelineId ? { pipelineId: String(req.query.pipelineId) } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ deployments: deployments.map(present) });
});

deploymentsRouter.post('/', async (req, res) => {
  const pipeline = await ownPipeline(String(req.body?.pipelineId ?? ''), req.userId);
  const type = req.body?.type;
  if (!TYPES.includes(type)) throw new HttpError(400, 'type must be cron, webhook or api');
  parseGraph(pipeline.graph); // refuse to deploy a graph that can't run

  const d = await prisma.deployment.create({
    data: {
      pipelineId: pipeline.id,
      userId: req.userId,
      type,
      cronExpression: type === 'cron' ? validateCron(req.body.cronExpression) : null,
      webhookSecret: type === 'cron' ? null : randomBytes(24).toString('base64url'),
      syncTimeout: type === 'api' ? Math.min(Math.max(Number(req.body.syncTimeout) || 30, 1), 120) : 30,
    },
  });
  if (type === 'cron') await scheduleCron(d.id, d.cronExpression!);
  res.status(201).json({ deployment: present(d) });
});

deploymentsRouter.patch('/:id', async (req, res) => {
  const d = await ownDeployment(req.params.id, req.userId);
  const active = req.body?.active === undefined ? d.active : !!req.body.active;
  const cronExpression = d.type === 'cron' && req.body?.cronExpression !== undefined ? validateCron(req.body.cronExpression) : d.cronExpression;
  const updated = await prisma.deployment.update({ where: { id: d.id }, data: { active, cronExpression } });
  if (d.type === 'cron') await (active ? scheduleCron(d.id, cronExpression!) : unscheduleCron(d.id));
  res.json({ deployment: present(updated) });
});

deploymentsRouter.delete('/:id', async (req, res) => {
  const d = await ownDeployment(req.params.id, req.userId);
  if (d.type === 'cron') await unscheduleCron(d.id);
  await prisma.deployment.delete({ where: { id: d.id } });
  res.status(204).end();
});

deploymentsRouter.get('/:id/runs', async (req, res) => {
  const d = await ownDeployment(req.params.id, req.userId);
  const runs = await prisma.run.findMany({
    where: { deploymentId: d.id },
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: { id: true, status: true, error: true, startedAt: true, finishedAt: true, tokensUsed: true },
  });
  res.json({ runs: runs.map((r) => ({ ...r, durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null })) });
});

// ---------- Public endpoints (no JWT; authenticated by the deployment secret) ----------

/** Fixed window, per deployment. */
async function rateLimit(deploymentId: string, perMinute = 60) {
  const key = `rl:${deploymentId}:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 61);
  if (n > perMinute) throw new HttpError(429, 'Too many requests for this deployment; try again in a minute');
}

/**
 * Accepts either the shared secret in X-Webhook-Secret, or an HMAC-SHA256 of the raw body
 * in X-Webhook-Signature ("sha256=<hex>"). Both comparisons are constant-time.
 */
function verifySecret(req: Request, d: Deployment) {
  const secret = d.webhookSecret!;
  const given = req.get('x-webhook-secret');
  const sig = req.get('x-webhook-signature')?.replace(/^sha256=/, '');
  const raw: Buffer = (req as any).rawBody ?? Buffer.from('');
  const ok = (given && safeEqual(given, secret)) || (sig && safeEqual(sig.toLowerCase(), hmacHex(secret, raw)));
  if (!ok) throw new HttpError(401, 'Missing or invalid webhook secret');
}

async function loadPublic(id: string, type: 'webhook' | 'api') {
  // Unknown, wrong-type and paused deployments all look the same from outside.
  const d = await prisma.deployment.findUnique({ where: { id }, include: { pipeline: true } }).catch(() => null);
  if (!d || d.type !== type || !d.active) throw new HttpError(404, 'Not found');
  return d;
}

export const publicRouter = Router();

publicRouter.post('/webhooks/:deploymentId', async (req, res) => {
  const d = await loadPublic(req.params.deploymentId, 'webhook');
  verifySecret(req, d);
  await rateLimit(d.id);
  const run = await createRun({ userId: d.userId, graph: parseGraph(d.pipeline.graph), input: req.body ?? null, pipelineId: d.pipelineId, deploymentId: d.id });
  await prisma.deployment.update({ where: { id: d.id }, data: { lastRunAt: new Date() } });
  res.status(202).json({ runId: run.id });
});

publicRouter.post('/api/:deploymentId/invoke', async (req, res) => {
  const d = await loadPublic(req.params.deploymentId, 'api');
  verifySecret(req, d);
  await rateLimit(d.id);
  const run = await createRun({ userId: d.userId, graph: parseGraph(d.pipeline.graph), input: req.body ?? null, pipelineId: d.pipelineId, deploymentId: d.id, enqueue: false });
  await prisma.deployment.update({ where: { id: d.id }, data: { lastRunAt: new Date() } });

  // Subscribe before enqueueing so the worker's "done" can't arrive first.
  const sub = newRedis();
  try {
    const done = new Promise<any>((resolve) => {
      sub.on('message', (_ch, msg) => {
        const e = JSON.parse(msg);
        if (e.type === 'done') resolve(e);
      });
    });
    await sub.subscribe(runChannel(run.id));
    await enqueueRun(run.id);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), d.syncTimeout * 1000));
    const result = await Promise.race([done, timeout]);
    if (!result) {
      return void res.status(504).json({ error: `Run did not finish within ${d.syncTimeout}s`, runId: run.id, status: 'RUNNING' });
    }
    res.status(result.status === 'SUCCESS' ? 200 : 500).json({ runId: run.id, status: result.status, error: result.error ?? undefined, output: result.output });
  } finally {
    sub.disconnect();
  }
});
