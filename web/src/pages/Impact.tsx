import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type CatalogFilterOptions, type Product, type ProductMetric } from "../api/client";
import { CatalogFilterBar } from "../components/CatalogFilterBar";
import { shortId } from "../lib/format";

export function Impact() {
  const [searchParams] = useSearchParams();
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<number | null>(() => {
    const fromQuery = searchParams.get("productId");
    return fromQuery ? Number(fromQuery) : null;
  });
  const [metrics, setMetrics] = useState<ProductMetric[]>([]);

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [filters, setFilters] = useState<CatalogFilterOptions | null>(null);

  useEffect(() => {
    api.listProducts().then(setProducts);
    api.catalogFilters()
      .then(setFilters)
      .catch(() => setFilters({ categories: [], brands: [] }));
  }, []);

  useEffect(() => {
    if (selected == null) return;
    api.productMetrics(selected).then(setMetrics);
  }, [selected]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
  }

  const filteredProducts = products.filter((p) => {
    if (search) {
      const term = search.toLowerCase();
      if (!p.title.toLowerCase().includes(term) && !p.vtexProductId.includes(term) && !p.vtexSkuId.includes(term)) return false;
    }
    if (categoryId && p.category !== categoryId) return false;
    if (brandId && p.brand !== brandId) return false;
    return true;
  });

  const gscHistory = metrics.filter((m) => m.source === "gsc").sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const ga4History = metrics.filter((m) => m.source === "ga4").sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Impacto (antes/depois)</h1>
          <p className="muted">
            Cada snapshot é gravado quando o Analyst roda para um produto. Rodar novos enrichment
            runs ao longo dos dias cria a série "antes vs. depois" que sustenta a métrica de impacto
            no Search Console e no GA4 — para uma leitura imediata, sem esperar o Google, veja o
            score de conteúdo em cada run.
          </p>
        </div>
      </div>

      <div className="page-content">
        <section className="card">
          <CatalogFilterBar
            search={search}
            setSearch={setSearch}
            categoryId={categoryId}
            setCategoryId={setCategoryId}
            brandId={brandId}
            setBrandId={setBrandId}
            filters={filters}
            onSubmit={handleSearch}
          />
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value ? Number(e.target.value) : null)}
            style={{ marginTop: "0.75rem" }}
          >
            <option value="">Selecione um produto</option>
            {filteredProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({shortId(p.vtexProductId)})
              </option>
            ))}
          </select>
        </section>

        {selected == null ? (
          <div className="empty-state">Selecione um produto para ver o histórico de métricas.</div>
        ) : (
          <>
            <section className="card">
              <h2>Search Console</h2>
              {gscHistory.length === 0 ? (
                <div className="empty-state">Sem dado ainda — rode um enrichment run com este produto no escopo.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Coletado em</th>
                      <th>Impressões</th>
                      <th>Cliques</th>
                      <th>CTR</th>
                      <th>Posição média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gscHistory.map((m) => (
                      <tr key={m.id}>
                        <td>{new Date(m.fetchedAt).toLocaleDateString("pt-BR")}</td>
                        <td>{m.impressions}</td>
                        <td>{m.clicks}</td>
                        <td>{m.ctr ? `${(Number(m.ctr) * 100).toFixed(1)}%` : "—"}</td>
                        <td>{m.avgPosition ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <h2>GA4</h2>
              {ga4History.length === 0 ? (
                <div className="empty-state">Sem dado ainda — rode um enrichment run com este produto no escopo.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Coletado em</th>
                      <th>Sessões</th>
                      <th>Conversão</th>
                      <th>Receita</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ga4History.map((m) => (
                      <tr key={m.id}>
                        <td>{new Date(m.fetchedAt).toLocaleDateString("pt-BR")}</td>
                        <td>{m.sessions}</td>
                        <td>{m.conversionRate ? `${(Number(m.conversionRate) * 100).toFixed(1)}%` : "—"}</td>
                        <td>{m.revenue ? `R$ ${Number(m.revenue).toFixed(2)}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
