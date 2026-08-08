import { and, eq, like, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { products } from "../db/schema.js";
import type { CatalogPlatform } from "../clients/catalog-types.js";
import { fetchPageText } from "../clients/web-fetch.client.js";
import { resolveLlmClient } from "../lib/llm-client-resolver.js";
import type { PageContentType } from "../repositories/page-content.repo.js";

const MAX_SAMPLE_TITLES = 15;
const MAX_RELATED_VALUES = 10;
const MAX_REFERENCE_CHARS = 4000;
export const MAX_REFERENCE_URLS = 2;

export interface GeneratedPageContent {
  seoTitle: string;
  metaDescription: string;
  keywords: string;
}

export interface PageContentGenerationResult {
  content: GeneratedPageContent;
  /** How many real products this was grounded in — surfaced to the operator so a suspiciously low
   *  count (e.g. 1-2 products) is visible before they trust the draft. */
  productCount: number;
  /** One entry per referenceUrl that was given but whose fetched text was too short to trust (see
   *  web-fetch.client.ts's FetchedPageText.warning) — the draft still gets generated (references are
   *  inspirational, not required), just without that URL's grounding. Empty when every reference
   *  fetched cleanly or none were given. */
  referenceWarnings: string[];
}

const SCHEMA = {
  type: "object",
  properties: {
    seoTitle: {
      type: "string",
      description: "Title tag da página de listagem (categoria/marca), ate ~60 caracteres, incluindo o nome real da categoria/marca.",
    },
    metaDescription: {
      type: "string",
      description: "Meta description da página de listagem, 150-160 caracteres, atrativa para clique na busca, baseada nos produtos reais informados.",
    },
    keywords: {
      type: "string",
      description: "Palavras-chave/termos similares separados por virgula, relevantes aos produtos reais informados — nunca genericas demais nem inventadas.",
    },
  },
  required: ["seoTitle", "metaDescription", "keywords"],
};

const PAGE_TYPE_LABEL: Record<PageContentType, string> = {
  department: "departamento",
  category: "categoria",
  subcategory: "subcategoria",
  brand: "marca",
};

const SYSTEM_INSTRUCTION =
  "Você escreve SEO (título da página, meta description e palavras-chave) para uma PÁGINA DE LISTAGEM de e-commerce " +
  "(categoria, subcategoria, departamento ou marca) — não é a página de um produto específico, é a página que lista " +
  "vários produtos. Baseie-se APENAS nos produtos reais informados (títulos de amostra e marcas/categorias " +
  "relacionadas) — nunca invente produtos, marcas, características ou números que não estejam nos dados fornecidos. " +
  "Se um ou mais trechos de referência de mercado forem fornecidos, use-os apenas como inspiração de ESTRUTURA/TOM " +
  "(o que um bom texto desse tipo de página costuma cobrir) — nunca copie ou parafraseie frases deles, e nunca " +
  "reproduza nomes de produtos/marcas deles que não apareçam nos nossos próprios dados.";

interface ProductSample {
  count: number;
  titles: string[];
  related: string[];
}

/** Real products under this scope — the "nossos dados" grounding. Department/category/subcategory
 *  match products.category by exact value OR by breadcrumb prefix (`scopeKey + " > "`, same " > "
 *  separator vtex.client.ts's formatVtexCategoryPath writes), since products are classified at their
 *  own leaf level, not at every ancestor. Brand matches products.brand exactly — orthogonal to the
 *  category tree, same as page-content.repo.ts's PageContentType doc comment. */
async function sampleScopedProducts(platform: CatalogPlatform, pageType: PageContentType, scopeKey: string): Promise<ProductSample> {
  const where =
    pageType === "brand"
      ? and(eq(products.platform, platform), eq(products.brand, scopeKey))
      : and(eq(products.platform, platform), or(eq(products.category, scopeKey), like(products.category, `${scopeKey} > %`)));

  const rows = await db.query.products.findMany({
    where,
    columns: { title: true, brand: true, category: true },
    limit: 200,
  });

  const relatedValues = new Set<string>();
  for (const row of rows) {
    const value = pageType === "brand" ? row.category : row.brand;
    if (value) relatedValues.add(value);
    if (relatedValues.size >= MAX_RELATED_VALUES) break;
  }

  return {
    count: rows.length,
    titles: rows.slice(0, MAX_SAMPLE_TITLES).map((r) => r.title),
    related: [...relatedValues],
  };
}

/** Generates a draft (never auto-saved — the operator still reviews/edits/saves via the normal
 *  page-content form) for one Departamento/Categoria/Subcategoria/Marca page, grounded in this
 *  store's own real products under that scope, plus up to MAX_REFERENCE_URLS market-reference URLs
 *  for structural inspiration only. Refuses the catalog-wide `'*'` scope — "all departments" has no
 *  coherent real product set to ground a draft in. */
export async function generatePageContent(params: {
  platform: CatalogPlatform;
  pageType: PageContentType;
  scopeKey: string;
  referenceUrls?: string[];
}): Promise<PageContentGenerationResult> {
  if (params.scopeKey === "*") {
    throw new Error("Selecione uma categoria/marca específica (não o padrão geral) para gerar com IA — a geração precisa de produtos reais para se basear.");
  }

  const sample = await sampleScopedProducts(params.platform, params.pageType, params.scopeKey);
  if (sample.count === 0) {
    throw new Error("Nenhum produto encontrado para este escopo — não há dados reais para basear a geração.");
  }

  const referenceUrls = (params.referenceUrls ?? []).map((u) => u.trim()).filter(Boolean).slice(0, MAX_REFERENCE_URLS);
  const referenceExcerpts: string[] = [];
  const referenceWarnings: string[] = [];
  for (const url of referenceUrls) {
    const page = await fetchPageText(url);
    referenceExcerpts.push(page.text.slice(0, MAX_REFERENCE_CHARS));
    if (page.warning) referenceWarnings.push(`${url}: ${page.warning}`);
  }

  const relatedLabel = params.pageType === "brand" ? "Categorias relacionadas" : "Marcas relacionadas";
  const textParts = [
    `Tipo de página: ${PAGE_TYPE_LABEL[params.pageType]}`,
    `Nome real da categoria/marca: ${params.scopeKey}`,
    `Quantidade de produtos reais nesta página: ${sample.count}`,
    `Amostra de títulos de produtos reais:\n${sample.titles.map((t) => `- ${t}`).join("\n")}`,
    sample.related.length > 0 ? `${relatedLabel}: ${sample.related.join(", ")}` : null,
    ...referenceExcerpts.map(
      (excerpt, i) =>
        `Trecho de referência de mercado ${i + 1}/${referenceExcerpts.length} (SOMENTE inspiração de estrutura/tom — nunca copiar frases nem nomes de produtos/marcas dele):\n${excerpt}`,
    ),
  ].filter((part): part is string => Boolean(part));

  const llm = await resolveLlmClient("contentEnrichment");
  const content = await llm.extractStructuredData<GeneratedPageContent>({
    operation: "generatePageContent",
    systemInstruction: SYSTEM_INSTRUCTION,
    text: textParts.join("\n\n"),
    schema: SCHEMA,
  });

  return { content, productCount: sample.count, referenceWarnings };
}
