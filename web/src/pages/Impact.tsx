import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type BusinessImpactSummary, type CatalogFilterOptions, type ImpactSummary, type Product, type RealImpact } from "../api/client";
import { BusinessImpactPanel } from "../components/BusinessImpactPanel";
import { CatalogFilterBar } from "../components/CatalogFilterBar";
import { ImpactSummaryBanner } from "../components/ImpactSummaryBanner";
import { RealImpactPanel } from "../components/RealImpactPanel";
import { shortId } from "../lib/format";

export function Impact() {
  const [searchParams] = useSearchParams();
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<number | null>(() => {
    const fromQuery = searchParams.get("productId");
    return fromQuery ? Number(fromQuery) : null;
  });
  const [realImpact, setRealImpact] = useState<RealImpact | null>(null);
  const [impactSummary, setImpactSummary] = useState<ImpactSummary | null>(null);
  const [businessImpact, setBusinessImpact] = useState<BusinessImpactSummary | null>(null);

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [filters, setFilters] = useState<CatalogFilterOptions | null>(null);

  useEffect(() => {
    api.listProducts().then(setProducts);
    api.catalogFilters()
      .then(setFilters)
      .catch(() => setFilters({ categories: [], brands: [] }));
    api.overallImpactSummary().then(setImpactSummary);
    api.businessImpact().then(setBusinessImpact).catch((err) => console.error("Failed to load business impact", err));
  }, []);

  useEffect(() => {
    if (selected == null) return;
    setRealImpact(null);
    api.productRealImpact(selected).then(setRealImpact);
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

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Impacto (antes/depois)</h1>
          <p className="muted">
            Consulta em tempo real ao Search Console e ao GA4, sem cópia local. O corte "antes/depois" é a primeira
            publicação do produto: GA4 pode dar leitura preliminar em 3 dias; GSC/SEO entra como leitura madura após 14 dias.
          </p>
        </div>
      </div>

      <div className="page-content">
        {impactSummary && <ImpactSummaryBanner summary={impactSummary} />}
        {businessImpact && <BusinessImpactPanel summary={businessImpact} onSelectProduct={setSelected} />}

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
          <div className="empty-state">Selecione um produto para ver o impacto real (Google).</div>
        ) : (
          <section className="card">
            <h2>Impacto real (Google)</h2>
            {realImpact ? <RealImpactPanel impact={realImpact} /> : <p className="muted">Consultando…</p>}
          </section>
        )}
      </div>
    </>
  );
}
