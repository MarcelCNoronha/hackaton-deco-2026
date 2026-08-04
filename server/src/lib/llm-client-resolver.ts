import { ClaudeClient } from "../clients/claude.client.js";
import { OpenAiClient } from "../clients/openai.client.js";
import { GeminiClient } from "../clients/gemini.client.js";
import type { LlmClient } from "../clients/llm-types.js";
import { getConnectionCredentials } from "../repositories/connections.repo.js";
import { getModelRouting, type LlmTask } from "../repositories/model-routing.repo.js";
import { makeRequestLogger } from "../repositories/logs.repo.js";

/** Resolves whichever provider/model is routed for `task`, outside of any enrichment-run context
 *  — used by reference-structure.agent.ts / reference-facts.agent.ts, which run when a merchant
 *  saves a reference link/URL in the UI, not as part of a run's product loop (see
 *  enrichment-run.orchestrator.ts's requireConnectedClients for the run-scoped equivalent, which
 *  this deliberately doesn't reuse — it needs a runId-tied logger this call site doesn't have). */
export async function resolveLlmClient(task: LlmTask): Promise<LlmClient> {
  const routing = await getModelRouting();
  const row = routing.find((r) => r.task === task);
  if (!row) throw new Error(`Nenhum roteamento de modelo configurado para a tarefa "${task}".`);

  const creds = await getConnectionCredentials(row.provider);
  if (!creds) {
    throw new Error(`Conexão do provedor "${row.provider}" não está configurada — configure no painel de Integrações primeiro.`);
  }

  const logger = makeRequestLogger();
  if (row.provider === "anthropic") return new ClaudeClient(creds.apiKey, row.model, logger);
  if (row.provider === "openai") return new OpenAiClient(creds.apiKey, row.model, logger);
  return new GeminiClient(creds.apiKey, row.model, logger);
}
