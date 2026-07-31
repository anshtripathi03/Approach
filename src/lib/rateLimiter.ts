import { NextResponse } from "next/server";

interface RateLimitConfig {
  limit: number;      // max requests
  windowMs: number;   // time window in milliseconds
}

/**
 * In-memory store for rate limiting.
 * Key: IP or identifier (e.g., userId)
 * Value: Array of timestamps of recent requests
 */
const rateLimitStore = new Map<string, number[]>();

/**
 * Standard Next.js custom rate limiter utility.
 * Use inside API routes or middleware.
 * 
 * Returns { success: boolean, retryAfter: number }
 */
export function rateLimiter(identifier: string, config: RateLimitConfig) {
  const now = Date.now();
  const windowStart = now - config.windowMs;

  let requestLogs = rateLimitStore.get(identifier) || [];

  // Filter logs within current window
  requestLogs = requestLogs.filter((timestamp) => timestamp > windowStart);

  if (requestLogs.length >= config.limit) {
    const oldestTimestamp = requestLogs[0];
    const retryAfter = Math.ceil((oldestTimestamp + config.windowMs - now) / 1000);
    return { success: false, retryAfter };
  }

  // Record new request
  requestLogs.push(now);
  rateLimitStore.set(identifier, requestLogs);

  return { success: true, retryAfter: 0 };
}

/**
 * Response helper for rate limiting
 */
export function rateLimitResponse(retryAfter: number) {
  return NextResponse.json(
    {
      error: "Too many requests. Please try again later.",
      retryAfterSeconds: retryAfter,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
      },
    }
  );
}

/**
 * In-memory idempotency-key store.
 * Key: caller-supplied idempotency key (namespaced per route)
 * Value: the JSON-serializable result to replay + its expiry timestamp
 */
interface IdempotencyEntry {
  result: unknown;
  status: number;
  expiresAt: number;
}

const idempotencyStore = new Map<string, IdempotencyEntry>();
const IDEMPOTENCY_TTL_MS = 5 * 60_000; // 5 minutes

function pruneExpiredIdempotencyKeys(now: number) {
  Array.from(idempotencyStore.entries()).forEach(([key, entry]) => {
    if (entry.expiresAt <= now) idempotencyStore.delete(key);
  });
}

/**
 * Returns the cached response for this idempotency key if it was already
 * processed within the TTL window, otherwise null.
 */
export function getIdempotentResult(key: string): { result: unknown; status: number } | null {
  const now = Date.now();
  pruneExpiredIdempotencyKeys(now);

  const entry = idempotencyStore.get(key);
  if (!entry || entry.expiresAt <= now) return null;
  return { result: entry.result, status: entry.status };
}

/**
 * Records the result of processing an idempotency key so replays within
 * the TTL window return the same response instead of re-executing.
 */
export function storeIdempotentResult(key: string, result: unknown, status: number) {
  idempotencyStore.set(key, {
    result,
    status,
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });
}
