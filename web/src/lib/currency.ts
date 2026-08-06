function formatSmall(value: number, symbol: string): string {
  return `${symbol}${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** LLM providers bill in USD, so CatalogIA shows AI cost in USD everywhere. */
export function formatCost(usdValue: number): string {
  return formatSmall(usdValue, "$");
}
