import { Redis } from "ioredis";
import { env } from "../config/env.js";

// Separate connection from the BullMQ queue's (queue/connection.ts) — that one is configured
// specifically for BullMQ's blocking/retry semantics; this is just plain INCR/EXPIRE counters.
const redis = new Redis(env.VALKEY_URL);

/** Shared across every server instance and surviving restarts (unlike an in-memory Map) — a login
 *  or 2FA brute-force attempt from a rotating IP or hitting a different container instance still
 *  counts against the same window. */
export async function checkRateLimit(key: string, maxAttempts: number): Promise<boolean> {
  const count = await redis.get(`ratelimit:${key}`);
  return !count || Number(count) < maxAttempts;
}

export async function recordAttempt(key: string, success: boolean, windowSeconds: number): Promise<void> {
  const redisKey = `ratelimit:${key}`;
  if (success) {
    await redis.del(redisKey);
    return;
  }
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, windowSeconds);
}
