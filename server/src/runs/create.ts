import { prisma } from '../db.ts';
import { enqueueRun } from '../queue.ts';
import { HttpError } from '../api/http.ts';
import type { Graph } from '../engine/types.ts';

export const dailyBudget = () => Number(process.env.DAILY_TOKEN_BUDGET ?? 50_000);

/** Optional blended USD price per million tokens; null hides money amounts (prices vary by model). */
export const costPerMillion = () => {
  const v = Number(process.env.TOKEN_COST_PER_MILLION);
  return Number.isFinite(v) && v > 0 ? v : null;
};

const startOfDay = () => {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return since;
};

export async function tokensUsedToday(userId: string) {
  const agg = await prisma.run.aggregate({ where: { userId, startedAt: { gte: startOfDay() } }, _sum: { tokensUsed: true } });
  return agg._sum.tokensUsed ?? 0;
}

/** Tokens all runs of a team's pipelines used today, whoever started them. */
export async function teamTokensUsedToday(teamId: string) {
  const agg = await prisma.run.aggregate({ where: { pipeline: { teamId }, startedAt: { gte: startOfDay() } }, _sum: { tokensUsed: true } });
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
  if (opts.pipelineId) {
    const team = (await prisma.pipeline.findUnique({ where: { id: opts.pipelineId }, select: { team: { select: { id: true, name: true, dailyTokenBudget: true } } } }))?.team;
    if (team?.dailyTokenBudget) {
      const teamUsed = await teamTokensUsedToday(team.id);
      if (teamUsed >= team.dailyTokenBudget) throw new HttpError(429, `Team “${team.name}” has used its daily token budget (${teamUsed.toLocaleString()} / ${team.dailyTokenBudget.toLocaleString()}). It resets at midnight.`);
    }
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
