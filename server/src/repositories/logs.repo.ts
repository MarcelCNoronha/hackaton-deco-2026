import { db } from "../db/client.js";
import { agentRequestLogs } from "../db/schema.js";
import type { RequestLogEntry } from "../clients/http.js";

/** Persists one external-API-call log entry. Used as the onAttempt callback for every client. */
export function makeRequestLogger(runId?: number) {
  return async (entry: RequestLogEntry) => {
    try {
      await db.insert(agentRequestLogs).values({
        ...(runId !== undefined ? { runId } : {}),
        provider: entry.provider,
        operation: entry.operation,
        endpoint: entry.endpoint,
        method: entry.method,
        statusCode: entry.statusCode,
        success: entry.success,
        attempt: entry.attempt,
        durationMs: entry.durationMs,
        error: entry.error,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costUsd: entry.costUsd?.toString(),
        ...(entry.productId !== undefined ? { productId: entry.productId } : {}),
      });
    } catch (err) {
      // Logging must never break the actual sync/enrichment — only log to stderr.
      console.error("Failed to persist agent_request_log entry", err);
    }
  };
}
