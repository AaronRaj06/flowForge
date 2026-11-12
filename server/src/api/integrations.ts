import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.ts';
import { providers } from '../integrations/registry.ts';
import { saveToken } from '../integrations/tokens.ts';
import { HttpError } from './http.ts';
import { requireAuth } from './auth.ts';

export const integrationsRouter = Router();

const redirectUri = (provider: string) => `${process.env.PUBLIC_URL ?? 'http://localhost:4000'}/api/integrations/${provider}/callback`;
const provider = (id: string) => {
  const p = providers[id];
  if (!p) throw new HttpError(404, `Unknown integration "${id}"`);
  return p;
};

/** Popup result page: tells the opener to refresh, then closes itself. */
const popupPage = (ok: boolean, message: string) => {
  const safe = message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const origin = JSON.stringify(process.env.WEB_URL ?? 'http://localhost:5173');
  return `<!doctype html><meta charset="utf-8"><title>Flowforge</title>
<body style="font:14px system-ui;display:grid;place-items:center;height:90vh;color:#1c1c19">
<p>${safe}</p>
<script>try{window.opener&&window.opener.postMessage({type:'flowforge:oauth',ok:${ok}},${origin})}catch(e){}${ok ? 'setTimeout(()=>window.close(),600)' : ''}</script>`;
};

integrationsRouter.get('/', requireAuth(), async (req, res) => {
  const rows = await prisma.integrationToken.findMany({ where: { userId: req.userId }, select: { provider: true, expiresAt: true } });
  res.json({
    integrations: Object.values(providers).map((p) => {
      const row = rows.find((r) => r.provider === p.id);
      return { provider: p.id, label: p.label, configured: p.configured(), connected: !!row, expiresAt: row?.expiresAt ?? null };
    }),
  });
});

// Opened in a popup via window.open, so the JWT comes in the query string.
integrationsRouter.get('/:provider/connect', requireAuth({ allowQueryToken: true }), (req, res) => {
  const p = provider(String(req.params.provider));
  if (!p.configured()) throw new HttpError(400, `${p.label} OAuth is not configured on this server`);
  const state = jwt.sign({ sub: req.userId, provider: p.id }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  res.redirect(p.authorizeUrl(state, redirectUri(p.id)));
});

integrationsRouter.get('/:provider/callback', async (req, res) => {
  const p = provider(String(req.params.provider));
  if (req.query.error) return void res.status(400).send(popupPage(false, `${p.label} connection was cancelled.`));
  let userId: string;
  try {
    const state = jwt.verify(String(req.query.state ?? ''), process.env.JWT_SECRET!) as jwt.JwtPayload;
    if (state.provider !== p.id || !state.sub) throw new Error();
    userId = state.sub;
  } catch {
    return void res.status(400).send(popupPage(false, 'This sign-in link expired. Close this window and try again.'));
  }
  try {
    const tokens = await p.exchangeCode(String(req.query.code ?? ''), redirectUri(p.id));
    await saveToken(userId, p.id, tokens);
    res.send(popupPage(true, `${p.label} connected. You can close this window.`));
  } catch (err) {
    res.status(400).send(popupPage(false, `Couldn’t connect ${p.label}: ${(err as Error).message}`));
  }
});

integrationsRouter.delete('/:provider', requireAuth(), async (req, res) => {
  await prisma.integrationToken.deleteMany({ where: { userId: req.userId, provider: String(req.params.provider) } });
  res.status(204).end();
});
