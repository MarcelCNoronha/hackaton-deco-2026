import { useEffect, useState } from "react";
import { api, type CatalogPlatform, type CategoryTreeNode, type PageContentType, type RealImpact } from "../api/client";
import { RealImpactPanel } from "../components/RealImpactPanel";

const PAGE_TYPE_LABELS: Record<PageContentType, string> = {
  department: "Departamento",
  category: "Categoria",
  subcategory: "Subcategoria",
  brand: "Marca",
};

const PAGE_TYPE_LEVEL: Record<Exclude<PageContentType, "brand">, number> = { department: 1, category: 2, subcategory: 3 };

export function PageImpact() {
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");
  const [categoryNodes, setCategoryNodes] = useState<CategoryTreeNode[]>([]);
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);

  const [pageType, setPageType] = useState<PageContentType>("category");
  const [scopeKey, setScopeKey] = useState<string>("");

  const [impact, setImpact] = useState<RealImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getCatalogPlatform().then(({ platform }) => setPlatform(platform));
    api.getCategoryNodes().then(({ nodes }) => setCategoryNodes(nodes));
    api.catalogFilters().then(({ brands }) => setBrands(brands));
  }, []);

  useEffect(() => {
    if (!scopeKey) {
      setImpact(null);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .pageRealImpact(pageType, scopeKey)
      .then(setImpact)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [pageType, scopeKey]);

  function handlePageTypeChange(next: PageContentType) {
    setPageType(next);
    setScopeKey("");
  }

  const scopeOptions =
    pageType === "brand"
      ? brands.map((b) => ({ value: b.name, label: b.name }))
      : categoryNodes.filter((n) => n.level === PAGE_TYPE_LEVEL[pageType]).map((n) => ({ value: n.path, label: n.path }));

  const isUnavailable = platform !== "vtex";

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Impacto de Páginas</h1>
          <p className="muted">
            Antes/depois real do Search Console e GA4 para páginas de Departamento/Categoria/Subcategoria/Marca — mesma
            lógica do Impacto de Produto, pivotada na primeira publicação de cada página em vez do produto.
          </p>
        </div>
      </div>

      <div className="page-content">
        {isUnavailable ? (
          <section className="card">
            <p className="muted" style={{ margin: 0 }}>
              Shopify não tem hierarquia de categorias nem um campo de conteúdo de marca equivalente — esta tela só
              está disponível com a VTEX como plataforma ativa.
            </p>
          </section>
        ) : (
          <>
            <section className="card">
              <h2 style={{ marginTop: 0 }}>Página</h2>
              <div className="actions" style={{ marginTop: 0, marginBottom: "0.9rem", flexWrap: "wrap" }}>
                {(Object.keys(PAGE_TYPE_LABELS) as PageContentType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={t === pageType ? "" : "secondary"}
                    onClick={() => handlePageTypeChange(t)}
                  >
                    {PAGE_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
              <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
                <option value="">Selecione uma {PAGE_TYPE_LABELS[pageType].toLowerCase()}…</option>
                {scopeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {pageType !== "brand" && scopeOptions.length === 0 && (
                <p className="muted" style={{ marginTop: "0.75rem" }}>
                  Nenhum {PAGE_TYPE_LABELS[pageType].toLowerCase()} sincronizado ainda — sincronize as categorias na
                  Configuração de PDP primeiro.
                </p>
              )}
            </section>

            {scopeKey && (
              <section className="card" style={{ marginTop: "1.5rem" }}>
                <h2 style={{ marginTop: 0 }}>{scopeKey}</h2>
                {error && <div className="banner">{error}</div>}
                {loading ? (
                  <p className="muted">Carregando…</p>
                ) : (
                  impact && <RealImpactPanel impact={impact} subject="página" />
                )}
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
