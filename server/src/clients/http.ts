import type { agentRequestLogs } from "../db/schema.js";

type Provider = (typeof agentRequestLogs.$inferInsert)["provider"];

/** Thrown for 4xx (except 429) — signals the retry loop to stop immediately. */
export class NonRetryableHttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "NonRetryableHttpError";
  }
}

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface RequestLogEntry {
  provider: Provider;
  operation: string;
  endpoint: string;
  method: string;
  statusCode?: number;
  success: boolean;
  attempt: number;
  durationMs: number;
  error?: string;
  /** Anthropic calls only — which model ran, token usage, and the computed USD cost. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Product this call was made on behalf of, when applicable — enables per-product cost views. */
  productId?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
// Real VTEX call durations (agent_request_logs, prod) sit at 200-450ms average, ~900ms worst
// case observed — 20s gives ample room for a real slowdown while still failing fast instead of
// hanging forever. A hung connection-test request with no timeout is what left VTEX looking
// "disconnected" after a deploy killed the container mid-request (2026-08-05).
const DEFAULT_TIMEOUT_MS = 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with the Mundial/AnyMarket retry pattern: exponential backoff, retry only on
 * HTTP 429/5xx or network errors, respect `Retry-After` if present, throw immediately
 * on any other 4xx (NonRetryableHttpError) so callers/BullMQ don't waste attempts.
 */
export async function requestWithRetry(params: {
  provider: Provider;
  operation: string;
  url: string;
  init?: RequestInit;
  retry?: RetryConfig;
  timeoutMs?: number;
  onAttempt?: (entry: RequestLogEntry) => void | Promise<void>;
}): Promise<Response> {
  const maxAttempts = params.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = params.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetch(params.url, { ...params.init, signal: AbortSignal.timeout(timeoutMs) });
      const durationMs = Date.now() - startedAt;

      if (response.ok) {
        await params.onAttempt?.({
          provider: params.provider,
          operation: params.operation,
          endpoint: params.url,
          method: params.init?.method ?? "GET",
          statusCode: response.status,
          success: true,
          attempt,
          durationMs,
        });
        return response;
      }

      const isRetryable = response.status === 429 || response.status >= 500;
      await params.onAttempt?.({
        provider: params.provider,
        operation: params.operation,
        endpoint: params.url,
        method: params.init?.method ?? "GET",
        statusCode: response.status,
        success: false,
        attempt,
        durationMs,
        error: `HTTP ${response.status}`,
      });

      if (!isRetryable) {
        throw new NonRetryableHttpError(response.status, `${params.operation} failed with HTTP ${response.status}`);
      }

      lastError = new Error(`${params.operation} failed with HTTP ${response.status}`);
      if (attempt === maxAttempts) break;

      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;
      const backoffMs = baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.max(backoffMs, retryAfterMs));
    } catch (err) {
      if (err instanceof NonRetryableHttpError) throw err;

      const durationMs = Date.now() - startedAt;
      lastError = err;
      await params.onAttempt?.({
        provider: params.provider,
        operation: params.operation,
        endpoint: params.url,
        method: params.init?.method ?? "GET",
        success: false,
        attempt,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });

      if (attempt === maxAttempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${params.operation} failed after ${maxAttempts} attempts`);
}
