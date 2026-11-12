import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';

export const prisma = new PrismaClient();

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export const redisOptions = { maxRetriesPerRequest: null } as const;
export const newRedis = () => new Redis(REDIS_URL, redisOptions);
// Lazy, so importing the engine (e.g. in tests) does not hold a socket open.
export const redis = new Redis(REDIS_URL, { ...redisOptions, lazyConnect: true });

export const runChannel = (runId: string) => `run:${runId}`;
export const CANCEL_CHANNEL = 'run-cancel';
