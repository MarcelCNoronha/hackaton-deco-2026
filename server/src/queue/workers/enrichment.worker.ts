import { Worker } from "bullmq";
import { queueConnection } from "../connection.js";
import { executeEnrichmentRun } from "../../orchestrator/enrichment-run.orchestrator.js";
import type { EnrichmentJobData } from "../queues.js";

// Concurrency capped at 5: keeps us comfortably under Claude/VTEX per-account rate limits
// even when several products are being enriched across concurrently-running jobs.
export const enrichmentWorker = new Worker<EnrichmentJobData>(
  "enrichment",
  async (job) => {
    const { runId, ...params } = job.data;
    return executeEnrichmentRun(runId, params);
  },
  { connection: queueConnection, concurrency: 5 },
);

enrichmentWorker.on("failed", (job, err) => {
  console.error(`Enrichment job ${job?.id} failed:`, err);
});
