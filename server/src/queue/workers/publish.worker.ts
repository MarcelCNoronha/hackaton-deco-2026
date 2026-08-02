import { Worker } from "bullmq";
import { queueConnection } from "../connection.js";
import { publishRun } from "../../orchestrator/enrichment-run.orchestrator.js";
import type { PublishJobData } from "../queues.js";

// Low concurrency on purpose: this writes to the real production VTEX catalog.
export const publishWorker = new Worker<PublishJobData>(
  "publish",
  async (job) => {
    return publishRun(job.data.runId);
  },
  { connection: queueConnection, concurrency: 2 },
);

publishWorker.on("failed", (job, err) => {
  console.error(`Publish job ${job?.id} failed:`, err);
});
