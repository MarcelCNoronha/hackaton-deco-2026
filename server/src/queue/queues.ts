import { Queue } from "bullmq";
import { queueConnection } from "./connection.js";
import type { StartEnrichmentRunParams } from "../orchestrator/enrichment-run.orchestrator.js";

export interface EnrichmentJobData extends StartEnrichmentRunParams {
  runId: number;
}
export interface PublishJobData {
  runId: number;
}

// Concurrency lives on the Worker side (see workers/*.ts); these are just the queue defs.
// attempts+exponential backoff here replace the manual retry loop from the Mundial reference —
// this covers *job-level* retries (e.g. the whole run crashed), while per-HTTP-call retry still
// happens inside clients/http.ts (a single flaky VTEX call shouldn't discard an entire run).
export const enrichmentQueue = new Queue<EnrichmentJobData>("enrichment", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

// jobId = `publish:${runId}` deduplicates so the same run can't be published twice concurrently —
// the Node/BullMQ equivalent of the named Cache::lock used for AnyMarket sync-publications.
export const publishQueue = new Queue<PublishJobData>("publish", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

export async function enqueueEnrichmentRun(data: EnrichmentJobData) {
  // BullMQ custom job IDs can't contain ":" (used internally as the Redis key delimiter).
  return enrichmentQueue.add("run", data, { jobId: `enrich-${data.runId}` });
}

export async function enqueuePublishRun(runId: number) {
  const jobId = `publish-${runId}`;

  // A stable jobId only dedupes an *in-flight* publish (waiting/active/delayed) — but BullMQ also
  // silently no-ops add() against a job left over in a *terminal* state (completed/failed) with
  // the same id, which would permanently block ever retrying a run whose publish partially failed
  // (e.g. one proposal's platform call errored). Clearing a terminal job first lets a retry
  // actually re-run, while still protecting against a genuine concurrent double-click.
  const existing = await publishQueue.getJob(jobId);
  if (existing && ["completed", "failed"].includes(await existing.getState())) {
    await existing.remove();
  }

  return publishQueue.add("publish", { runId }, { jobId });
}
