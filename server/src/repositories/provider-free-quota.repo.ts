import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentRequestLogs, providerFreeQuotas } from "../db/schema.js";
import type { LlmProvider } from "../clients/llm-types.js";

export interface FreeQuotaStatus {
  provider: LlmProvider;
  enabled: boolean;
  quotaUsd: number;
  resetIntervalHours: number;
  periodStartAt: string;
  /** ISO timestamp of the next automatic reset. */
  resetAt: string;
  periodSpentUsd: number;
  exhausted: boolean;
}

const LLM_PROVIDERS: LlmProvider[] = ["anthropic", "openai", "gemini"];

/** Advances a stale period forward by whole intervals (lazily, on read) so the quota "resets"
 *  without needing a background job — e.g. a 24h quota checked 50h later jumps 2 whole periods
 *  ahead, not just to "now", keeping the reset schedule aligned. */
async function currentPeriodStart(provider: LlmProvider, periodStartAt: Date, resetIntervalHours: number): Promise<Date> {
  const intervalMs = resetIntervalHours * 60 * 60 * 1000;
  const elapsedMs = Date.now() - periodStartAt.getTime();
  const elapsedIntervals = Math.floor(elapsedMs / intervalMs);
  if (elapsedIntervals <= 0) return periodStartAt;

  const advanced = new Date(periodStartAt.getTime() + elapsedIntervals * intervalMs);
  await db.update(providerFreeQuotas).set({ periodStartAt: advanced }).where(eq(providerFreeQuotas.provider, provider));
  return advanced;
}

export async function getFreeQuotaStatuses(): Promise<FreeQuotaStatus[]> {
  const rows = await db.query.providerFreeQuotas.findMany();
  const rowByProvider = new Map(rows.map((r) => [r.provider, r]));

  const results: FreeQuotaStatus[] = [];
  for (const provider of LLM_PROVIDERS) {
    const row = rowByProvider.get(provider);
    if (!row) {
      results.push({
        provider,
        enabled: false,
        quotaUsd: 0,
        resetIntervalHours: 24,
        periodStartAt: new Date().toISOString(),
        resetAt: new Date().toISOString(),
        periodSpentUsd: 0,
        exhausted: false,
      });
      continue;
    }

    const periodStartAt = await currentPeriodStart(provider, row.periodStartAt, row.resetIntervalHours);
    const [spendRow] = await db
      .select({ spent: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)` })
      .from(agentRequestLogs)
      .where(and(eq(agentRequestLogs.provider, provider), gte(agentRequestLogs.createdAt, periodStartAt)));

    const periodSpentUsd = Number(spendRow?.spent ?? 0);
    const quotaUsd = Number(row.quotaUsd);
    results.push({
      provider,
      enabled: row.enabled,
      quotaUsd,
      resetIntervalHours: row.resetIntervalHours,
      periodStartAt: periodStartAt.toISOString(),
      resetAt: new Date(periodStartAt.getTime() + row.resetIntervalHours * 60 * 60 * 1000).toISOString(),
      periodSpentUsd,
      exhausted: row.enabled && periodSpentUsd >= quotaUsd,
    });
  }
  return results;
}

export async function setFreeQuotaConfig(
  provider: LlmProvider,
  config: { enabled: boolean; quotaUsd: number; resetIntervalHours: number },
): Promise<void> {
  await db
    .insert(providerFreeQuotas)
    .values({
      provider,
      enabled: config.enabled,
      quotaUsd: config.quotaUsd.toString(),
      resetIntervalHours: config.resetIntervalHours,
      periodStartAt: new Date(),
    })
    .onConflictDoUpdate({
      target: providerFreeQuotas.provider,
      set: {
        enabled: config.enabled,
        quotaUsd: config.quotaUsd.toString(),
        resetIntervalHours: config.resetIntervalHours,
        // Restart the period so a freshly-edited quota isn't immediately "exhausted" by stale spend.
        periodStartAt: new Date(),
      },
    });
}

/** Providers (among the given list) whose free-tier quota is enabled and already exhausted for
 *  the current period — used as a second run-creation gate alongside the all-time spend limit. */
export async function findExhaustedFreeQuotaProviders(providers: LlmProvider[]): Promise<FreeQuotaStatus[]> {
  if (providers.length === 0) return [];
  const all = await getFreeQuotaStatuses();
  return all.filter((s) => providers.includes(s.provider) && s.exhausted);
}
