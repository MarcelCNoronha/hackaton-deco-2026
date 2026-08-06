import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentRequestLogs, providerSpendLimits } from "../db/schema.js";
import type { LlmProvider } from "../clients/llm-types.js";

export interface ProviderSpend {
  provider: LlmProvider;
  /** null = no limit configured for this provider. */
  limitUsd: number | null;
  /** Spend so far in the current calendar month (resets on the 1st). */
  spentUsd: number;
  /** ISO timestamp of the current month's start. */
  periodStartAt: string;
}

const LLM_PROVIDERS: LlmProvider[] = ["anthropic", "openai", "gemini"];

function firstOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Lazily advances a stale period to the start of the current calendar month, so monthly spend
 *  limits reset without a background job. */
async function currentPeriodStart(provider: LlmProvider, periodStartAt: Date): Promise<Date> {
  const currentMonthStart = firstOfMonthUtc(new Date());
  if (periodStartAt.getTime() >= currentMonthStart.getTime()) return periodStartAt;
  await db
    .update(providerSpendLimits)
    .set({ periodStartAt: currentMonthStart })
    .where(eq(providerSpendLimits.provider, provider));
  return currentMonthStart;
}

export async function getProviderSpend(): Promise<ProviderSpend[]> {
  const limitRows = await db.query.providerSpendLimits.findMany();
  const limitByProvider = new Map(limitRows.map((r) => [r.provider, r]));
  const currentMonthStart = firstOfMonthUtc(new Date());

  const results: ProviderSpend[] = [];
  for (const provider of LLM_PROVIDERS) {
    const row = limitByProvider.get(provider);
    const periodStartAt = row ? await currentPeriodStart(provider, row.periodStartAt) : currentMonthStart;

    const [spendRow] = await db
      .select({ spent: sql<string>`coalesce(sum(${agentRequestLogs.costUsd}), 0)` })
      .from(agentRequestLogs)
      .where(and(eq(agentRequestLogs.provider, provider), gte(agentRequestLogs.createdAt, periodStartAt)));

    results.push({
      provider,
      limitUsd: row ? Number(row.limitUsd) : null,
      spentUsd: Number(spendRow?.spent ?? 0),
      periodStartAt: periodStartAt.toISOString(),
    });
  }
  return results;
}

export async function setProviderSpendLimit(provider: LlmProvider, limitUsd: number | null): Promise<void> {
  if (limitUsd === null) {
    await db.delete(providerSpendLimits).where(eq(providerSpendLimits.provider, provider));
    return;
  }
  const now = new Date();
  await db
    .insert(providerSpendLimits)
    .values({ provider, limitUsd: limitUsd.toString(), periodStartAt: firstOfMonthUtc(now), updatedAt: now })
    .onConflictDoUpdate({
      target: providerSpendLimits.provider,
      // Deliberately not touching periodStartAt here — raising/lowering the limit mid-month
      // shouldn't reset spend-to-date; only an actual new-month rollover should do that.
      set: { limitUsd: limitUsd.toString(), updatedAt: now },
    });
}

/** Providers (among the given list) that have already reached/exceeded their spend limit for the
 *  current month — used as a run-creation gate so a run can't start on a provider already over
 *  budget this month. This is a circuit breaker checked at run start, not a live reservation. */
export async function findExceededProviders(providers: LlmProvider[]): Promise<ProviderSpend[]> {
  if (providers.length === 0) return [];
  const all = await getProviderSpend();
  return all.filter((p) => providers.includes(p.provider) && p.limitUsd !== null && p.spentUsd >= p.limitUsd);
}
