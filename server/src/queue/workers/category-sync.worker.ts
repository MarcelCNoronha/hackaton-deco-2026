import { Worker } from "bullmq";
import { queueConnection } from "../connection.js";
import { runCategorySync } from "../../orchestrator/category-sync.orchestrator.js";

// concurrency: 1 — only one platform is active at a time, so there's never more than one useful
// sync job in flight anyway.
export const categorySyncWorker = new Worker(
  "category-sync",
  async () => {
    return runCategorySync();
  },
  { connection: queueConnection, concurrency: 1 },
);

categorySyncWorker.on("failed", (job, err) => {
  console.error(`Category sync job ${job?.id} failed:`, err);
});
