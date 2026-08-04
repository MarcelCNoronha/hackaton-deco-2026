/** Bounded-concurrency version of `Promise.allSettled` — caps how many `fn` calls run at once
 *  instead of firing every item's async work simultaneously. Without this, an enrichment run with
 *  many products (e.g. "otimização total" with topN=50) fires 50+ simultaneous LLM calls per task
 *  type (content, alt-text, image generation), risking provider rate-limit errors and cost spikes
 *  under real load. `limit` workers pull the next index off a shared counter until the list is
 *  exhausted, so a slow item never blocks a free worker from picking up the next one. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        const value = await fn(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
