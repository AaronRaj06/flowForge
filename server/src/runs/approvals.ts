import type { Prisma } from '@prisma/client';
import { prisma, redis, runChannel } from '../db.ts';
import { enqueueRun } from '../queue.ts';
import { HttpError } from '../api/http.ts';
import { hmacHex } from '../lib/crypto.ts';
import { sendEmail } from '../integrations/gmail/actions.ts';
import { postMessage } from '../integrations/slack/actions.ts';
import type { NodeDef } from '../engine/types.ts';

const secret = () => process.env.APPROVAL_SECRET || process.env.JWT_SECRET || '';
export const approvalToken = (runId: string, nodeId: string) => hmacHex(secret(), `approval:${runId}:${nodeId}`);
export const approvalUrl = (runId: string, nodeId: string) =>
  `${process.env.PUBLIC_URL ?? 'http://localhost:4000'}/approvals/${runId}/${approvalToken(runId, nodeId)}`;

/** Sends the approval request by email and/or Slack, if the block asks for it. Failures are logged: the request is still answerable in the app. */
export async function notifyApprover(run: { id: string; userId: string }, node: NodeDef, request: string) {
  const link = approvalUrl(run.id, node.id);
  const text = `${request || 'A pipeline is waiting for your approval.'}\n\nApprove or reject: ${link}`;
  const cfg = node.config ?? {};
  const sends: Promise<unknown>[] = [];
  if (cfg.notifyEmail) sends.push(sendEmail({ to: cfg.notifyEmail, subject: 'Approval needed', body: text }, {}, run.userId));
  if (cfg.notifySlack) sends.push(postMessage({ channel: cfg.notifySlack, text }, {}, run.userId));
  for (const r of await Promise.allSettled(sends)) {
    if (r.status === 'rejected') console.error(`approval notification for run ${run.id} failed:`, r.reason?.message ?? r.reason);
  }
}

/** Records the decision on a WAITING run and queues it to resume. Only the first decision counts. */
export async function decide(runId: string, approved: boolean, comment?: unknown) {
  const claimed = await prisma.run.updateMany({ where: { id: runId, status: 'WAITING' }, data: { status: 'PENDING' } });
  if (!claimed.count) throw new HttpError(409, 'This run is not waiting for approval (it may already have been decided)');
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  const cp = run.checkpoint as { context: Record<string, any>; nodeId: string };
  cp.context.__approvals = { ...cp.context.__approvals, [cp.nodeId]: { approved, comment: comment ? String(comment).slice(0, 2000) : null, decidedAt: new Date().toISOString() } };
  await prisma.run.update({ where: { id: runId }, data: { checkpoint: cp as Prisma.InputJsonValue } });
  await redis.publish(runChannel(runId), JSON.stringify({ type: 'resumed' }));
  await enqueueRun(runId, `${runId}-resume-${Date.now()}`);
  return { approved };
}
