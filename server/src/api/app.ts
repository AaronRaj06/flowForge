import express from 'express';
import cors from 'cors';
import { authRouter, requireAuth } from './auth.ts';
import { errorHandler } from './http.ts';
import { pipelinesRouter } from './pipelines.ts';
import { runsRouter, streamRun, usageRouter } from './runs.ts';
import { integrationsRouter } from './integrations.ts';
import { templatesRouter } from './templates.ts';
import { kbRouter } from './kb.ts';
import { deploymentsRouter, publicRouter } from './deployments.ts';
import { aiRouter } from './ai.ts';
import { approvalsRouter } from './approvals.ts';
import { credentialsRouter } from './credentials.ts';
import { teamsRouter, auditRouter } from './teams.ts';
import { prisma, redis } from '../db.ts';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Security headers for the API and the server-rendered form/approval pages (nginx adds HSTS over TLS).
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  app.use(cors({ origin: process.env.WEB_URL ?? 'http://localhost:5173' }));
  // Keep the raw bytes so webhook signatures can be checked against exactly what was sent.
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => void ((req as any).rawBody = buf) }));

  // Readiness: the API is only useful when it can reach Postgres and Redis.
  app.get('/api/health', async (_req, res) => {
    const check = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]).catch(() => false);
    const [db, cache] = await Promise.all([check(prisma.$queryRaw`SELECT 1`), check(redis.ping())]);
    res.status(db && cache ? 200 : 503).json({ ok: db && cache, db, redis: cache });
  });
  app.use('/api/auth', authRouter);
  app.use('/api/integrations', integrationsRouter);
  app.get('/api/runs/:id/stream', requireAuth({ allowQueryToken: true }), streamRun);
  app.use('/api/pipelines', requireAuth(), pipelinesRouter);
  app.use('/api/runs', requireAuth(), runsRouter);
  app.use('/api/usage', requireAuth(), usageRouter);
  app.use('/api/templates', requireAuth(), templatesRouter);
  app.use('/api/kb', requireAuth(), kbRouter);
  app.use('/api/deployments', requireAuth(), deploymentsRouter);
  app.use('/api/ai', requireAuth(), aiRouter);
  app.use('/api/credentials', requireAuth(), credentialsRouter);
  app.use('/api/teams', requireAuth(), teamsRouter);
  app.use('/api/audit', requireAuth(), auditRouter);
  app.use(approvalsRouter); // /approvals/:runId/:token
  app.use(publicRouter); // /webhooks/:id and /api/:id/invoke

  app.use((_req, res) => void res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
