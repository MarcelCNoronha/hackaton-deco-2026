import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { pageContent } from "../db/schema.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";

export const DEFAULT_PAGE_CONTENT_KEY = "*";

/** "department"/"category"/"subcategory" match categoryNodes.level 1/2/3 and are keyed by the same
 *  breadcrumb `path` string. "brand" is keyed by the brand name instead — orthogonal to the
 *  category tree, no relation to categoryNodes. See schema.ts's doc comment on pageContent for why
 *  all 4 share this one table/shape (confirmed live: every one of the 4 VTEX admin edit screens
 *  exposes the exact same 3 fields, no more). */
export type PageContentType = "department" | "category" | "subcategory" | "brand";

export interface PageContentFields {
  seoTitle: string | null;
  metaDescription: string | null;
  keywords: string | null;
}

export interface PageContent extends PageContentFields {
  platform: CatalogPlatform;
  pageType: PageContentType;
  scopeKey: string;
  /** "specific" — this exact scopeKey has its own saved row. "default" — no row exists for it, so
   *  the fields are inherited from the catalog-wide `'*'` row for this pageType (empty if that
   *  doesn't exist either). Only meaningful for the admin editor — resolvePageContent (the
   *  publish-time path) doesn't need to know which case it hit. */
  source: "specific" | "default";
  /** Manual override of this page's real storefront URL — required for "brand" (VTEX has no
   *  auto-resolvable brand URL, see schema.ts's doc comment), optional override for the other 3
   *  types (auto-resolved from categoryNodes.url otherwise). Unlike seoTitle/metaDescription/
   *  keywords, NEVER inherited from the `'*'` fallback row — a URL is inherently specific to one
   *  page, a catalog-wide default row has no URL of its own. Null when this scopeKey has no saved
   *  row yet, same as source="default". See page-impact.agent.ts. */
  pageUrl: string | null;
  /** First time this exact scopeKey was actually published (see markPageContentFirstPublished) —
   *  null until the first publish. Also never inherited from the `'*'` fallback row, same reasoning
   *  as pageUrl. */
  firstPublishedAt: string | null;
}

export interface ResolvedPageContent extends PageContentFields {}

const EMPTY_FIELDS: PageContentFields = { seoTitle: null, metaDescription: null, keywords: null };

/** Resolves the effective content for one specific scopeKey (or the catalog-wide `'*'` default
 *  when omitted) — used by the admin editor, one page at a time. */
export async function getPageContent(
  platform: CatalogPlatform,
  pageType: PageContentType,
  scopeKey: string = DEFAULT_PAGE_CONTENT_KEY,
): Promise<PageContent> {
  const rows = await db.query.pageContent.findMany({
    where: and(eq(pageContent.platform, platform), eq(pageContent.pageType, pageType)),
  });
  const specificRow = rows.find((r) => r.scopeKey === scopeKey);
  if (specificRow) {
    return {
      platform,
      pageType,
      scopeKey,
      seoTitle: specificRow.seoTitle,
      metaDescription: specificRow.metaDescription,
      keywords: specificRow.keywords,
      pageUrl: specificRow.pageUrl,
      firstPublishedAt: specificRow.firstPublishedAt?.toISOString() ?? null,
      source: "specific",
    };
  }
  const fallbackRow = scopeKey !== DEFAULT_PAGE_CONTENT_KEY ? rows.find((r) => r.scopeKey === DEFAULT_PAGE_CONTENT_KEY) : undefined;
  return {
    platform,
    pageType,
    scopeKey,
    seoTitle: fallbackRow?.seoTitle ?? null,
    metaDescription: fallbackRow?.metaDescription ?? null,
    keywords: fallbackRow?.keywords ?? null,
    pageUrl: null,
    firstPublishedAt: null,
    source: "default",
  };
}

/** Resolves the effective content for one page at publish time, falling back to the catalog-wide
 *  `'*'` row, then to an empty page (no hardcoded factory default — unlike PDP, there's no sane
 *  non-empty default title/description to fall back to for an unconfigured category/brand page). */
export async function resolvePageContent(
  platform: CatalogPlatform,
  pageType: PageContentType,
  scopeKey: string,
): Promise<ResolvedPageContent> {
  const rows = await db.query.pageContent.findMany({
    where: and(eq(pageContent.platform, platform), eq(pageContent.pageType, pageType)),
  });
  const specific = rows.find((r) => r.scopeKey === scopeKey);
  const fallback = rows.find((r) => r.scopeKey === DEFAULT_PAGE_CONTENT_KEY);
  const row = specific ?? fallback;
  if (!row) return EMPTY_FIELDS;
  return { seoTitle: row.seoTitle, metaDescription: row.metaDescription, keywords: row.keywords };
}

export async function setPageContent(params: {
  platform: CatalogPlatform;
  pageType: PageContentType;
  scopeKey: string;
  seoTitle?: string | null;
  metaDescription?: string | null;
  keywords?: string | null;
  pageUrl?: string | null;
}): Promise<void> {
  const seoTitle = params.seoTitle?.trim() || null;
  const metaDescription = params.metaDescription?.trim() || null;
  const keywords = params.keywords?.trim() || null;
  const pageUrl = params.pageUrl?.trim() || null;
  await db
    .insert(pageContent)
    .values({
      platform: params.platform,
      pageType: params.pageType,
      scopeKey: params.scopeKey,
      seoTitle,
      metaDescription,
      keywords,
      pageUrl,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [pageContent.platform, pageContent.pageType, pageContent.scopeKey],
      set: { seoTitle, metaDescription, keywords, pageUrl, updatedAt: new Date() },
    });
}

/** Just the impact-relevant fields (URL + first-publish pivot) for one specific scopeKey — used by
 *  page-impact.agent.ts. Deliberately doesn't fall back to the `'*'` row (unlike getPageContent's
 *  text fields) — see PageContent.pageUrl's doc comment on why a URL/publish-history is never a
 *  sane thing to inherit from a catalog-wide default. */
export async function getPageContentPivot(
  platform: CatalogPlatform,
  pageType: PageContentType,
  scopeKey: string,
): Promise<{ pageUrl: string | null; firstPublishedAt: Date | null }> {
  const row = await db.query.pageContent.findFirst({
    where: and(eq(pageContent.platform, platform), eq(pageContent.pageType, pageType), eq(pageContent.scopeKey, scopeKey)),
  });
  return { pageUrl: row?.pageUrl ?? null, firstPublishedAt: row?.firstPublishedAt ?? null };
}

/** Marks this exact scopeKey's content as published for the first time — a no-op past the first
 *  call (COALESCE keeps whatever was already there), same "first non-null write wins" discipline as
 *  real-impact.repo.ts's earliest-publish tracking for products. Called right after a real,
 *  successful platform write (see page-publisher.agent.ts) — never speculatively. */
export async function markPageContentFirstPublished(platform: CatalogPlatform, pageType: PageContentType, scopeKey: string): Promise<void> {
  await db
    .update(pageContent)
    .set({ firstPublishedAt: sql`COALESCE(${pageContent.firstPublishedAt}, now())` })
    .where(and(eq(pageContent.platform, platform), eq(pageContent.pageType, pageType), eq(pageContent.scopeKey, scopeKey)));
}
