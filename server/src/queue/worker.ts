import "./workers/enrichment.worker.js";
import "./workers/publish.worker.js";

console.log("Workers listening: enrichment (concurrency 5), publish (concurrency 2)");
