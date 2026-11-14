import express, { Router } from 'express';
import { prisma } from '../db.ts';
import { safeEqual } from '../lib/crypto.ts';
import { approvalToken, decide } from '../runs/approvals.ts';
import { HttpError } from './http.ts';

/** Public approve/reject page for the link in approval emails and Slack messages; the HMAC token is the credential. */
export const approvalsRouter = Router();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approval · Flowforge</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}pre{white-space:pre-wrap;background:#f4f4f2;padding:.75rem;border-radius:6px}
textarea{width:100%;box-sizing:border-box;margin:.5rem 0}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;border-radius:6px;border:1px solid #ccc;cursor:pointer}.ok{background:#1a7f4b;color:#fff;border:0}</style>${body}`;

async function load(runId: string, token: string) {
  const run = await prisma.run.findUnique({ where: { id: runId }, include: { pipeline: { select: { name: true } } } }).catch(() => null);
  const cp = run?.checkpoint as { nodeId: string; request: string } | null;
  if (!run || !cp || !safeEqual(token, approvalToken(run.id, cp.nodeId))) throw new HttpError(404, 'Not found');
  return { run, cp };
}

approvalsRouter.get('/approvals/:runId/:token', async (req, res) => {
  const run = await prisma.run.findUnique({ where: { id: req.params.runId } }).catch(() => null);
  if (run && run.status !== 'WAITING') return void res.type('html').send(page(`<h1>Already decided</h1><p>This request is no longer waiting (run status: ${esc(run.status.toLowerCase())}).</p>`));
  const { run: r, cp } = await load(req.params.runId, req.params.token);
  res.type('html').send(
    page(`<h1>Approval needed</h1><p>Pipeline <b>${esc(r.pipeline?.name ?? 'Untitled')}</b> is waiting for a decision.</p>
<pre>${esc(cp.request || 'No details given.')}</pre>
<form method="post"><label>Comment (optional)<textarea name="comment" rows="3"></textarea></label>
<button class="ok" name="decision" value="approve">Approve</button><button name="decision" value="reject">Reject</button></form>`),
  );
});

approvalsRouter.post('/approvals/:runId/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const { run } = await load(req.params.runId, req.params.token);
  const approved = req.body?.decision === 'approve';
  await decide(run.id, approved, req.body?.comment);
  res.type('html').send(page(`<h1>${approved ? 'Approved' : 'Rejected'}</h1><p>Thanks. The pipeline is continuing.</p>`));
});
