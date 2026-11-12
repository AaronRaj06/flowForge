import type { Prisma } from '@prisma/client';
import { prisma, redis, runChannel } from '../db.ts';
import { runPipeline } from '../engine/runner.ts';
import { NodeExecutionError } from '../engine/errors.ts';
import type { Graph, RunEventPayload } from '../engine/types.ts';

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/** Persist a node event and fan it out to SSE listeners. */
async function recordEvent(runId: string, e: RunEventPayload) {
  const data = {
    status: e.status,
    output: json(e.output),
    error: e.error ?? null,
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

/** Executes a Run row end to end. Used by the queue worker and the test script. */
export async function executeRun(runId: string, signal?: AbortSignal) {
  const run = await prisma.run.update({ where: { id: runId }, data: { status: 'RUNNING' } });
  let status: 'SUCCESS' | 'ERROR' | 'CANCELLED' = 'SUCCESS';
  let output: unknown;
  let error: string | undefined;
  let tokensUsed = 0;
  try {
    const res = await runPipeline(run.graph as unknown as Graph, run.input, {
      userId: run.userId,
      signal,
      onEvent: (e) => recordEvent(runId, e),
    });
    output = res.context;
    tokensUsed = res.tokensUsed;
  } catch (err) {
    status = signal?.aborted ? 'CANCELLED' : 'ERROR';
    error = status === 'CANCELLED' ? 'Cancelled' : err instanceof Error ? err.message : String(err);
    if (status === 'ERROR' && !(err instanceof NodeExecutionError)) console.error(`run ${runId} failed before a node ran:`, err);
  }
  const finished = await prisma.run.update({
    where: { id: runId },
    data: { status, output: json(output), error, tokensUsed, finishedAt: new Date() },
  });
  await redis.publish(runChannel(runId), JSON.stringify({ type: 'done', status, error, output }));
  return finished;
}
