import { prisma } from '../db.ts';
import { enqueueRun } from '../queue.ts';
import { HttpError } from '../api/http.ts';
import type { Graph } from '../engine/types.ts';

export const dailyBudget = () => Number(process.env.DAILY_TOKEN_BUDGET ?? 50_000);

export async function tokensUsedToday(userId: string) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const agg = await prisma.run.aggregate({ where: { userId, startedAt: { gte: since } }, _sum: { tokensUsed: true } });
  return agg._sum.tokensUsed ?? 0;
}

/** Budget check, Run row, enqueue. Every trigger (UI, webhook, API invoke) goes through here. */
export async function createRun(opts: {
  userId: string;
  graph: Graph;
  input?: unknown;
  pipelineId?: string | null;
  deploymentId?: string | null;
  enqueue?: boolean;
}) {
  const used = await tokensUsedToday(opts.userId);
  if (used >= dailyBudget()) {
    throw new HttpError(429, `Daily token budget used up (${used.toLocaleString()} / ${dailyBudget().toLocaleString()}). It resets at midnight.`);
  }
  const run = await prisma.run.create({
    data: {
      userId: opts.userId,
      graph: opts.graph as object,
      input: (opts.input ?? null) as object,
      pipelineId: opts.pipelineId ?? null,
      deploymentId: opts.deploymentId ?? null,
    },
  });
  if (opts.enqueue !== false) await enqueueRun(run.id);
  return run;
}
