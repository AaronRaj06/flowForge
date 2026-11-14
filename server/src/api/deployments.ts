import { Router, type Request } from 'express';
import { randomBytes } from 'node:crypto';
import cronParser from 'cron-parser';
import multer from 'multer';
import type { Deployment } from '@prisma/client';
import { prisma, redis, newRedis, runChannel } from '../db.ts';
import { HttpError, parseGraph } from './http.ts';
import { ownPipeline } from './pipelines.ts';
import { accessPipeline, audit } from '../lib/access.ts';
import { scheduleCron, unscheduleCron, enqueueRun } from '../queue.ts';
import { createRun } from '../runs/create.ts';
import { safeEqual, hmacHex } from '../lib/crypto.ts';

export const deploymentsRouter = Router();
const TYPES = ['cron', 'webhook', 'api', 'form'] as const;
const MIN_CRON_INTERVAL_MS = 60_000;

const publicUrl = () => process.env.PUBLIC_URL ?? 'http://localhost:4000';
const present = (d: Deployment) => ({
  ...d,
  url: d.type === 'webhook' ? `${publicUrl()}/webhooks/${d.id}` : d.type === 'api' ? `${publicUrl()}/api/${d.id}/invoke` : d.type === 'form' ? `${publicUrl()}/forms/${d.id}` : undefined,
  webhookSecret: d.type === 'form' ? null : d.webhookSecret, // a form is public by design
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

/** Labels like "Name, Email, Message" → up to 20 trimmed, unique labels. */
function parseFormFields(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((s) => String(s).trim().slice(0, 60)).filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) throw new HttpError(400, 'A form needs at least one field, e.g. "Name, Email, Message"');
  if (unique.length > 20) throw new HttpError(400, 'Forms are limited to 20 fields');
  return unique;
}

/** Deployments are managed by whoever can edit their pipeline (team editors included); viewers never see secrets. */
async function ownDeployment(id: string, userId: string) {
  const d = await prisma.deployment.findUnique({ where: { id } }).catch(() => null);
  if (!d) throw new HttpError(404, 'Deployment not found');
  const p = await accessPipeline(d.pipelineId, userId, 'edit').catch((e) => {
    throw e.status === 403 ? e : new HttpError(404, 'Deployment not found');
  });
  return { ...d, teamId: p.teamId };
}

deploymentsRouter.get('/', async (req, res) => {
  const pipelineId = req.query.pipelineId ? (await accessPipeline(String(req.query.pipelineId), req.userId, 'edit')).id : null;
  const deployments = await prisma.deployment.findMany({
    where: pipelineId ? { pipelineId } : { userId: req.userId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ deployments: deployments.map(present) });
});

deploymentsRouter.post('/', async (req, res) => {
  const pipeline = await ownPipeline(String(req.body?.pipelineId ?? ''), req.userId);
  const type = req.body?.type;
  if (!TYPES.includes(type)) throw new HttpError(400, 'type must be cron, webhook, api or form');
  parseGraph(pipeline.graph); // refuse to deploy a graph that can't run

  const d = await prisma.deployment.create({
    data: {
      pipelineId: pipeline.id,
      userId: req.userId,
      type,
      cronExpression: type === 'cron' ? validateCron(req.body.cronExpression) : null,
      webhookSecret: type === 'cron' ? null : randomBytes(24).toString('base64url'),
      formFields: type === 'form' ? parseFormFields(req.body.formFields) : [],
      formFile: type === 'form' && !!req.body.formFile,
      syncTimeout: type === 'api' ? Math.min(Math.max(Number(req.body.syncTimeout) || 30, 1), 120) : 30,
    },
  });
  if (type === 'cron') await scheduleCron(d.id, d.cronExpression!);
  await audit(req.userId, 'deployment.create', { teamId: pipeline.teamId, targetType: 'deployment', targetId: d.id, detail: { pipeline: pipeline.name, type } });
  res.status(201).json({ deployment: present(d) });
});

deploymentsRouter.patch('/:id', async (req, res) => {
  const d = await ownDeployment(req.params.id, req.userId);
  const active = req.body?.active === undefined ? d.active : !!req.body.active;
  const cronExpression = d.type === 'cron' && req.body?.cronExpression !== undefined ? validateCron(req.body.cronExpression) : d.cronExpression;
  const updated = await prisma.deployment.update({ where: { id: d.id }, data: { active, cronExpression } });
  if (d.type === 'cron') await (active ? scheduleCron(d.id, cronExpression!) : unscheduleCron(d.id));
  await audit(req.userId, active ? 'deployment.resume' : 'deployment.pause', { teamId: d.teamId, targetType: 'deployment', targetId: d.id, detail: { type: d.type } });
  res.json({ deployment: present(updated) });
});

deploymentsRouter.delete('/:id', async (req, res) => {
  const d = await ownDeployment(req.params.id, req.userId);
  if (d.type === 'cron') await unscheduleCron(d.id);
  await prisma.deployment.delete({ where: { id: d.id } });
  await audit(req.userId, 'deployment.delete', { teamId: d.teamId, targetType: 'deployment', targetId: d.id, detail: { type: d.type } });
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

async function loadPublic(id: string, type: 'webhook' | 'api' | 'form') {
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

// ---------- Form trigger: a public page whose submissions start runs ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const formPage = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}label{display:block;margin:.75rem 0 .25rem;font-weight:500}
input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:.45rem;border:1px solid #ccc;border-radius:6px}button{margin-top:1rem;font:inherit;padding:.5rem 1rem;border-radius:6px;border:0;background:#1c1c19;color:#fff;cursor:pointer}</style>
<h1>${esc(title)}</h1>${body}`;
// shortcut: text files only (read as UTF-8, up to 1 MB); add PDF parsing like the KB upload if forms need it.
const formUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1, fields: 40 } });

publicRouter.get('/forms/:deploymentId', async (req, res) => {
  const d = await loadPublic(req.params.deploymentId, 'form');
  const fields = d.formFields.map((f, i) => `<label for="f${i}">${esc(f)}</label>${/message|comment|description|details/i.test(f) ? `<textarea id="f${i}" name="${esc(f)}" rows="4"></textarea>` : `<input id="f${i}" name="${esc(f)}">`}`).join('');
  const file = d.formFile ? '<label for="file">File (text, up to 1 MB)</label><input id="file" type="file" name="file" accept=".txt,.md,.csv,.json,text/*">' : '';
  res.type('html').send(formPage(d.pipeline.name, `<form method="post" enctype="multipart/form-data">${fields}${file}<button>Submit</button></form>`));
});

publicRouter.post('/forms/:deploymentId', formUpload.single('file'), async (req, res) => {
  const d = await loadPublic(String(req.params.deploymentId), 'form');
  await rateLimit(d.id);
  const input: Record<string, unknown> = Object.fromEntries(d.formFields.map((f) => [f, String(req.body?.[f] ?? '').slice(0, 10_000)]));
  if (d.formFile && req.file) input.file = { name: req.file.originalname, type: req.file.mimetype, text: req.file.buffer.toString('utf8') };
  const run = await createRun({ userId: d.userId, graph: parseGraph(d.pipeline.graph), input, pipelineId: d.pipelineId, deploymentId: d.id });
  await prisma.deployment.update({ where: { id: d.id }, data: { lastRunAt: new Date() } });
  if (req.accepts(['html', 'json']) === 'json') return void res.status(202).json({ runId: run.id });
  res.type('html').send(formPage('Thanks!', '<p>Your submission was received.</p>'));
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
    res.status(result.status === 'SUCCESS' ? 200 : result.status === 'WAITING' ? 202 : 500).json({ runId: run.id, status: result.status, error: result.error ?? undefined, output: result.output });
  } finally {
    sub.disconnect();
  }
});
