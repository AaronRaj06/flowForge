import { Prisma } from '@prisma/client';
import { prisma, redis, runChannel } from '../db.ts';
import { runPipeline } from '../engine/runner.ts';
import { ApprovalPending, NodeExecutionError } from '../engine/errors.ts';
import { notifyApprover } from './approvals.ts';
import type { Graph, RunEventPayload } from '../engine/types.ts';
import { createRun } from './create.ts';

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/** Persist a node event and fan it out to SSE listeners. */
async function recordEvent(runId: string, e: RunEventPayload) {
  const data = {
    status: e.status,
    output: json(e.output),
    error: e.error ?? null,
    ...(e.tokens && { tokens: e.tokens }),
    ...(e.startedAt && { startedAt: e.startedAt }),
    ...(e.endedAt && { endedAt: e.endedAt }),
  };
  await prisma.runEvent.upsert({
    where: { runId_nodeId: { runId, nodeId: e.nodeId } },
    create: { runId, nodeId: e.nodeId, ...data },
    update: data,
  });
  await redis.publish(runChannel(runId), JSON.stringify({ type: 'node', ...e }));
}

/**
 * Starts the failed pipeline's error workflow, with the failure as its input.
 * Runs that were themselves started by an error workflow don't chain further.
 */
export async function triggerErrorPipeline(run: { id: string; userId: string; pipelineId: string | null; input: unknown }, error: string, failedNodeId?: string) {
  if (!run.pipelineId || (run.input as any)?.failedRun) return null;
  const failed = await prisma.pipeline.findUnique({ where: { id: run.pipelineId } });
  if (!failed?.errorPipelineId) return null;
  const target = await prisma.pipeline.findFirst({ where: { id: failed.errorPipelineId, userId: run.userId } });
  if (!target) return null; // deleted since it was chosen
  return createRun({
    userId: run.userId,
    graph: target.graph as unknown as Graph,
    pipelineId: target.id,
    input: { failedRun: { runId: run.id, pipelineId: failed.id, pipelineName: failed.name, error, failedNodeId: failedNodeId ?? null } },
  });
}

/** Executes a Run row end to end. Used by the queue worker and the test script. */
export async function executeRun(runId: string, signal?: AbortSignal) {
  const run = await prisma.run.update({ where: { id: runId }, data: { status: 'RUNNING' } });
  const graph = run.graph as unknown as Graph;
  // Resuming after an approval: restore the saved context and what each block already did.
  const cp = run.checkpoint as { context: Record<string, any> } | null;
  const resume = cp ? { context: cp.context, statuses: Object.fromEntries((await prisma.runEvent.findMany({ where: { runId } })).map((e) => [e.nodeId, e.status])) } : undefined;
  let status: 'SUCCESS' | 'ERROR' | 'CANCELLED' | 'WAITING' = 'SUCCESS';
  let output: unknown;
  let error: string | undefined;
  let tokensUsed = 0;
  let failedNodeId: string | undefined;
  try {
    const pipeline = run.pipelineId ? await prisma.pipeline.findUnique({ where: { id: run.pipelineId }, select: { maxTokensPerRun: true } }) : null;
    const res = await runPipeline(graph, run.input, {
      userId: run.userId,
      resume,
      maxTokens: pipeline?.maxTokensPerRun,
      signal,
      onEvent: (e) => recordEvent(runId, e),
    });
    const { __approvals: _, ...rest } = res.context; // internal resume state
    output = rest;
    tokensUsed = res.tokensUsed;
  } catch (err) {
    tokensUsed = (err as { tokensUsed?: number })?.tokensUsed ?? 0;
    if (err instanceof ApprovalPending && !signal?.aborted) {
      const checkpoint = json({ context: err.context, nodeId: err.nodeId, request: err.request })!;
      const paused = await prisma.run.update({ where: { id: runId }, data: { status: 'WAITING', checkpoint, tokensUsed: run.tokensUsed + tokensUsed } });
      await redis.publish(runChannel(runId), JSON.stringify({ type: 'done', status: 'WAITING', waiting: { nodeId: err.nodeId, request: err.request } }));
      const node = graph.nodes.find((n) => n.id === err.nodeId);
      if (node) await notifyApprover(run, node, err.request);
      return paused;
    }
    if (err instanceof NodeExecutionError) failedNodeId = err.nodeId;
    status = signal?.aborted ? 'CANCELLED' : 'ERROR';
    error = status === 'CANCELLED' ? 'Cancelled' : err instanceof Error ? err.message : String(err);
    if (status === 'ERROR' && !(err instanceof NodeExecutionError)) console.error(`run ${runId} failed before a node ran:`, err);
  }
  const finished = await prisma.run.update({
    where: { id: runId },
    data: { status, output: json(output), error, tokensUsed: run.tokensUsed + tokensUsed, checkpoint: Prisma.DbNull, finishedAt: new Date() },
  });
  await redis.publish(runChannel(runId), JSON.stringify({ type: 'done', status, error, output }));
  if (status === 'ERROR') {
    await triggerErrorPipeline(run, error!, failedNodeId).catch((e) => console.error(`error workflow for run ${runId} not started:`, e.message));
  }
  return finished;
}
