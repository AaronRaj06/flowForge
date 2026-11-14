import { Queue } from 'bullmq';
import { newRedis } from './db.ts';

export const QUEUE_NAME = 'pipeline-runs';

export type RunJob = { kind: 'run'; runId: string };
export type CronJob = { kind: 'cron'; deploymentId: string };

export const queueConnection = newRedis();
export const runQueue = new Queue<RunJob | CronJob>(QUEUE_NAME, { connection: queueConnection });

/** A resumed run (after an approval) needs a new job id: BullMQ ignores ids it has already seen. */
export function enqueueRun(runId: string, jobId = runId) {
  // One attempt: nodes can have side effects (emails, Slack posts) that must not repeat.
  return runQueue.add('run', { kind: 'run', runId }, { jobId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
}

export const schedulerId = (deploymentId: string) => `deployment:${deploymentId}`;

export function scheduleCron(deploymentId: string, pattern: string) {
  return runQueue.upsertJobScheduler(schedulerId(deploymentId), { pattern }, {
    name: 'cron',
    data: { kind: 'cron', deploymentId },
    opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  });
}

export function unscheduleCron(deploymentId: string) {
  return runQueue.removeJobScheduler(schedulerId(deploymentId));
}
