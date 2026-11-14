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

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: process.env.WEB_URL ?? 'http://localhost:5173' }));
  // Keep the raw bytes so webhook signatures can be checked against exactly what was sent.
  app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => void ((req as any).rawBody = buf) }));

  app.get('/api/health', (_req, res) => void res.json({ ok: true }));
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
  app.use(approvalsRouter); // /approvals/:runId/:token
  app.use(publicRouter); // /webhooks/:id and /api/:id/invoke

  app.use((_req, res) => void res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
