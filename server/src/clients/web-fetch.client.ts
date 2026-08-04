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

async function fetchRawHtml(url: string): Promise<string> {
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
  return res.text();
}

function toFetchedPageText(html: string): FetchedPageText {
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

/** Fetches a merchant-provided reference URL and returns its visible text — used by the
 *  category-level structure extraction (market reference ads). Never throws on a "the page loaded
 *  but has little content" outcome (see FetchedPageText.warning); only throws on an actual
 *  network/HTTP failure, which the caller surfaces to the user directly. */
export async function fetchPageText(url: string): Promise<FetchedPageText> {
  return toFetchedPageText(await fetchRawHtml(url));
}

const MAX_IMAGE_CANDIDATES = 4;
const IMG_NOISE_PATTERN = /logo|icon|sprite|pixel|favicon|placeholder|avatar/i;

function extractMetaImageUrls(html: string): string[] {
  const urls: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/i.test(tag)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i);
    if (content) urls.push(content[1]);
  }
  return urls;
}

function extractImgTagUrls(html: string): string[] {
  const urls: string[] = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) ?? tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i);
    if (!src) continue;
    if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(src[1])) continue;
    if (IMG_NOISE_PATTERN.test(src[1])) continue;
    urls.push(src[1]);
  }
  return urls;
}

/** Candidate product-photo URLs from a page — `og:image`/`twitter:image` first (the standard
 *  "this is THE representative image" convention nearly every e-commerce/manufacturer page sets
 *  for social sharing, so almost always the real product photo), then a handful of `<img>` tags as
 *  fallback, filtered by obvious noise (logo/icon/sprite/favicon) and file extension. Not a DOM
 *  parser — same "good enough for a real product page, not a general scraper" discipline as
 *  stripHtml — resolved to absolute URLs against the page's own URL. */
function extractCandidateImageUrls(html: string, baseUrl: string): string[] {
  const candidates = [...extractMetaImageUrls(html), ...extractImgTagUrls(html)];
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const src of candidates) {
    if (resolved.length >= MAX_IMAGE_CANDIDATES) break;
    try {
      const absolute = new URL(src, baseUrl).toString();
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      resolved.push(absolute);
    } catch {
      // Malformed src (e.g. an inline data: URI truncated by our tag regex) — skip rather than
      // fail the whole extraction over one bad candidate.
    }
  }
  return resolved;
}

export interface FetchedManufacturerPage extends FetchedPageText {
  /** Candidate product-photo URLs found on the page — see extractCandidateImageUrls. Empty when
   *  none matched; never throws for that, same as the text-side warning. */
  imageUrls: string[];
}

/** Same fetch as fetchPageText, plus candidate product-photo URLs — used only by the per-product
 *  manufacturer reference (reference-facts.agent.ts), which is the one place in the app that turns
 *  a reference page into a real, publishable image (see manufacturer-image.agent.ts). The
 *  category-level DNA extraction deliberately doesn't get this — those references are structure-
 *  only by design, never a source of real assets for a specific product. */
export async function fetchManufacturerPage(url: string): Promise<FetchedManufacturerPage> {
  const html = await fetchRawHtml(url);
  return { ...toFetchedPageText(html), imageUrls: extractCandidateImageUrls(html, url) };
}
