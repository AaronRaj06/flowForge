import { redis } from '../db.ts';
import { HttpError } from '../api/http.ts';

/** Fixed-window counter in Redis, shared by every API instance. Throws 429 once `limit` is passed. */
export async function rateLimit(key: string, limit: number, windowSec = 60, message = 'Too many requests; try again in a minute') {
  const k = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec + 1);
  if (n > limit) throw new HttpError(429, message, { retryAfterSeconds: windowSec });
}
