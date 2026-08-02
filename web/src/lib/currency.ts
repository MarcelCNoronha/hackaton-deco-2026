export type DisplayCurrency = "USD" | "BRL";

const CURRENCY_KEY = "display_currency";
const RATE_KEY = "brl_exchange_rate";
const DEFAULT_BRL_RATE = 5.0;

/** Costs are always computed/stored in USD (that's the currency every LLM provider bills in) —
 *  this only controls how they're *displayed*, converting at a manually configured rate rather
 *  than depending on a live FX feed. Persisted client-side since it's a presentation preference,
 *  not something the pipeline itself needs to know about. */
export function getDisplayCurrency(): DisplayCurrency {
  return localStorage.getItem(CURRENCY_KEY) === "BRL" ? "BRL" : "USD";
}

export function setDisplayCurrency(currency: DisplayCurrency): void {
  localStorage.setItem(CURRENCY_KEY, currency);
}

export function getBrlExchangeRate(): number {
  const raw = localStorage.getItem(RATE_KEY);
  const parsed = raw ? Number(raw) : DEFAULT_BRL_RATE;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRL_RATE;
}

export function setBrlExchangeRate(rate: number): void {
  localStorage.setItem(RATE_KEY, String(rate));
}

function formatSmall(value: number, symbol: string): string {
  return `${symbol}${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** Formats a USD cost value per the configured display currency. */
export function formatCost(usdValue: number): string {
  if (getDisplayCurrency() === "BRL") {
    return formatSmall(usdValue * getBrlExchangeRate(), "R$ ");
  }
  return formatSmall(usdValue, "$");
}
