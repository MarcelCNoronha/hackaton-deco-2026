const MAX_FETCH_BYTES = 3_000_000;
const MIN_TRUSTED_WORD_COUNT = 100;
const FETCH_TIMEOUT_MS = 15_000;

export interface FetchedPageText {
  text: string;
  wordCount: number;
  /** Set when the extracted text is too short to trust as a real product page — most likely a
   *  JS-rendered page whose meaningful content never appears in the raw HTML we fetched (no
   *  headless browser here, see reference-structure.agent.ts / reference-facts.agent.ts). Surfaced
   *  to the user instead of failing silently, per explicit product requirement. */
  warning: string | null;
}

/** Strips tags/scripts/styles and collapses whitespace — deterministic and cheap, so the LLM
 *  extraction step (reference-structure.agent.ts, reference-facts.agent.ts) spends its tokens on
 *  actual page content instead of markup/nav/footer boilerplate. Not a full HTML parser: good
 *  enough for "read the visible text of a product page", not a general-purpose scraper. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetches a merchant-provided reference URL and returns its visible text — used by both the
 *  category-level structure extraction (market reference ads) and the product-level facts
 *  extraction (manufacturer page). Never throws on a "the page loaded but has little content"
 *  outcome (see FetchedPageText.warning); only throws on an actual network/HTTP failure, which the
 *  caller surfaces to the user directly. */
export async function fetchPageText(url: string): Promise<FetchedPageText> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CatalogIA-ReferenceFetcher/1.0)" },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Falha ao buscar ${url}: HTTP ${res.status}`);

  const html = await res.text();
  const text = stripHtml(html.slice(0, MAX_FETCH_BYTES));
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return {
    text,
    wordCount,
    warning:
      wordCount < MIN_TRUSTED_WORD_COUNT
        ? "Conteúdo extraído é muito curto — a página pode carregar o conteúdo principal via JavaScript, que não aparece no HTML buscado."
        : null,
  };
}
