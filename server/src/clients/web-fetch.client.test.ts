import { describe, expect, it } from "vitest";
import { toFetchedPageText } from "./web-fetch.client.js";

describe("toFetchedPageText", () => {
  it("extracts a JSON-LD Product's description even though stripHtml alone would discard it (it's inside a <script>)", () => {
    const html = `<html><body><nav>Menu</nav>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org/",
        "@type": "Product",
        name: "Torneira Twin",
        brand: { name: "Deca" },
        description: "&lt;h2&gt;Torneira&lt;/h2&gt;&lt;p&gt;Alta vaz&#227;o e filtragem Carbon Block.&lt;/p&gt;",
      })}</script>
    </body></html>`;
    const result = toFetchedPageText(html);
    expect(result.text).toContain("Torneira Twin");
    expect(result.text).toContain("Deca");
    expect(result.text).toContain("Alta vazão e filtragem Carbon Block.");
    expect(result.text).not.toContain("<h2>");
    expect(result.text).not.toContain("&lt;");
  });

  it("unwraps a JSON-LD @graph array and only pulls the Product node out of it, skipping siblings like BreadcrumbList", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org/",
      "@graph": [
        { "@type": "BreadcrumbList", itemListElement: [] },
        { "@type": "Product", name: "Torneira Twin", description: "Descrição real do produto." },
      ],
    })}</script>`;
    const result = toFetchedPageText(html);
    expect(result.text).toContain("Torneira Twin");
    expect(result.text).toContain("Descrição real do produto.");
    expect(result.text).not.toContain("BreadcrumbList");
  });

  it("ignores malformed JSON-LD instead of failing the whole extraction", () => {
    const html = `<script type="application/ld+json">{not valid json</script><body><p>Texto visível da página, repetido bastante para passar do limite mínimo de palavras confiáveis que essa função usa para decidir se deve emitir um aviso de conteúdo curto ou não, então aqui vai bastante texto de enchimento adicional só para garantir que ultrapassamos esse limite com folga.</p></body>`;
    expect(() => toFetchedPageText(html)).not.toThrow();
    const result = toFetchedPageText(html);
    expect(result.text).toContain("Texto visível da página");
  });

  it("falls back to plain visible text when there's no JSON-LD at all", () => {
    const html = "<html><body><p>Descrição simples sem dado estruturado nenhum.</p></body></html>";
    const result = toFetchedPageText(html);
    expect(result.text).toContain("Descrição simples sem dado estruturado nenhum.");
  });

  it("still flags short content as a warning when neither JSON-LD nor visible text has enough words", () => {
    const html = "<html><body><p>Muito curto.</p></body></html>";
    const result = toFetchedPageText(html);
    expect(result.warning).not.toBeNull();
  });
});
