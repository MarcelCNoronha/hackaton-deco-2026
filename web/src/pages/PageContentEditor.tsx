import { useEffect, useState } from "react";
import {
  api,
  MAX_PAGE_CONTENT_REFERENCE_URLS,
  type CatalogPlatform,
  type CategoryTreeNode,
  type PageContent,
  type PageContentType,
} from "../api/client";

const PAGE_TYPE_LABELS: Record<PageContentType, string> = {
  department: "Departamento",
  category: "Categoria",
  subcategory: "Subcategoria",
  brand: "Marca",
};

const DEFAULT_SCOPE_KEY = "*";
const PAGE_TYPE_LEVEL: Record<Exclude<PageContentType, "brand">, number> = { department: 1, category: 2, subcategory: 3 };

const FIELD_TEXTAREA_STYLE = {
  width: "100%",
  resize: "vertical",
  padding: "0.55rem 0.7rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--page-plane)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: "0.85rem",
} as const;

export function PageContentEditor() {
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");
  const [categoryNodes, setCategoryNodes] = useState<CategoryTreeNode[]>([]);
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);

  const [pageType, setPageType] = useState<PageContentType>("category");
  const [scopeKey, setScopeKey] = useState<string>(DEFAULT_SCOPE_KEY);

  const [content, setContent] = useState<PageContent | null>(null);
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [referenceUrls, setReferenceUrls] = useState<string[]>([""]);
  const [generating, setGenerating] = useState(false);
  const [generationNote, setGenerationNote] = useState<string | null>(null);

  function updateReferenceUrl(index: number, value: string) {
    setReferenceUrls((prev) => prev.map((u, i) => (i === index ? value : u)));
  }

  function addReferenceUrl() {
    setReferenceUrls((prev) => (prev.length >= MAX_PAGE_CONTENT_REFERENCE_URLS ? prev : [...prev, ""]));
  }

  function removeReferenceUrl(index: number) {
    setReferenceUrls((prev) => (prev.length <= 1 ? [""] : prev.filter((_, i) => i !== index)));
  }

  useEffect(() => {
    api.getCatalogPlatform().then(({ platform }) => setPlatform(platform));
    api.getCategoryNodes().then(({ nodes }) => setCategoryNodes(nodes));
    api.catalogFilters().then(({ brands }) => setBrands(brands));
  }, []);

  useEffect(() => {
    setMessage(null);
    setError(null);
    setLoading(true);
    api
      .getPageContent(pageType, scopeKey)
      .then((c) => {
        setContent(c);
        setSeoTitle(c.seoTitle ?? "");
        setMetaDescription(c.metaDescription ?? "");
        setKeywords(c.keywords ?? "");
        setPageUrl(c.pageUrl ?? "");
      })
      .finally(() => setLoading(false));
  }, [pageType, scopeKey]);

  function handlePageTypeChange(next: PageContentType) {
    setPageType(next);
    setScopeKey(DEFAULT_SCOPE_KEY);
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    setMessage(null);
    setGenerationNote(null);
    try {
      const urls = referenceUrls.map((u) => u.trim()).filter(Boolean);
      const result = await api.generatePageContent(pageType, scopeKey, urls);
      setSeoTitle(result.content.seoTitle);
      setMetaDescription(result.content.metaDescription);
      setKeywords(result.content.keywords);
      const notes = [`Rascunho gerado com base em ${result.productCount} produto(s) real(is) deste escopo.`, ...result.referenceWarnings];
      setGenerationNote(notes.join(" "));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.setPageContent({ pageType, scopeKey, seoTitle, metaDescription, keywords, pageUrl });
      setContent(updated);
      setMessage("Rascunho salvo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    setMessage(null);
    try {
      await handleSave();
      await api.publishPageContent(pageType, scopeKey);
      setMessage("Publicado na VTEX.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  }

  const scopeOptions =
    pageType === "brand"
      ? brands.map((b) => ({ value: b.name, label: b.name }))
      : categoryNodes.filter((n) => n.level === PAGE_TYPE_LEVEL[pageType]).map((n) => ({ value: n.path, label: n.path }));

  const isDefaultScope = scopeKey === DEFAULT_SCOPE_KEY;
  const defaultLabel = `Todos os ${PAGE_TYPE_LABELS[pageType]}s (padrão)`;

  const isUnavailable = platform !== "vtex";

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Páginas de Departamento/Categoria/Subcategoria/Marca</h1>
          <p className="muted">
            Título, descrição (meta tag) e palavras similares/keywords para páginas além da PDP — os mesmos 3 campos
            que a VTEX aceita em Catálogo &gt; Categorias e Conteúdo &gt; Marcas. Vale pra plataforma ativa hoje:{" "}
            <strong>{platform === "vtex" ? "VTEX" : "Shopify"}</strong>.
          </p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}
        {error && <div className="banner">{error}</div>}

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
            <option value={DEFAULT_SCOPE_KEY}>{defaultLabel}</option>
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

        {isUnavailable ? (
          <section className="card" style={{ marginTop: "1.5rem" }}>
            <p className="muted" style={{ margin: 0 }}>
              Shopify não tem hierarquia de categorias nem um campo de conteúdo de marca equivalente — esta tela só
              está disponível com a VTEX como plataforma ativa.
            </p>
          </section>
        ) : (
          <section className="card" style={{ marginTop: "1.5rem" }}>
            <div className="proposal-header">
              <h2 style={{ margin: 0 }}>{PAGE_TYPE_LABELS[pageType]}</h2>
              <div className="actions" style={{ marginTop: 0 }}>
                <button type="button" className="secondary" onClick={handleSave} disabled={saving || publishing || loading}>
                  {saving ? "Salvando…" : "Salvar"}
                </button>
                <button type="button" onClick={handlePublish} disabled={saving || publishing || loading}>
                  {publishing ? "Publicando…" : "Publicar na VTEX"}
                </button>
              </div>
            </div>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.78rem" }}>
              {content?.source === "specific"
                ? `Conteúdo próprio de ${isDefaultScope ? defaultLabel : scopeKey}.`
                : isDefaultScope
                  ? "Ainda sem conteúdo — este é o padrão herdado por todos que não têm conteúdo próprio."
                  : "Ainda sem conteúdo próprio — herdando o padrão geral. Salvar cria um conteúdo só pra este item."}
            </p>

            <div style={{ background: "var(--surface-2)", borderRadius: "var(--radius-md)", padding: "0.75rem", marginBottom: "1rem" }}>
              <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.4rem" }}>
                Gerar rascunho com IA — baseado nos produtos reais deste escopo, com até {MAX_PAGE_CONTENT_REFERENCE_URLS}{" "}
                referências de mercado opcionais (usadas só como inspiração de estrutura, nunca copiadas).
              </span>
              {isDefaultScope ? (
                <p className="muted" style={{ margin: 0, fontSize: "0.78rem" }}>
                  Selecione uma {PAGE_TYPE_LABELS[pageType].toLowerCase()} específica acima para gerar com IA — o padrão
                  geral não tem produtos próprios para se basear.
                </p>
              ) : (
                <>
                  {referenceUrls.map((url, i) => (
                    <div key={i} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.4rem" }}>
                      <input
                        type="url"
                        placeholder={`URL de referência ${i + 1} (opcional)`}
                        value={url}
                        onChange={(e) => updateReferenceUrl(i, e.target.value)}
                        style={{ flex: "1 1 260px" }}
                      />
                      {(referenceUrls.length > 1 || url) && (
                        <button type="button" className="secondary" onClick={() => removeReferenceUrl(i)} title="Remover referência">
                          Remover
                        </button>
                      )}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
                    {referenceUrls.length < MAX_PAGE_CONTENT_REFERENCE_URLS && (
                      <button type="button" className="secondary" onClick={addReferenceUrl}>
                        + Adicionar referência
                      </button>
                    )}
                    <button type="button" onClick={handleGenerate} disabled={generating || loading}>
                      {generating ? "Gerando…" : "Gerar com IA"}
                    </button>
                  </div>
                  {generationNote && (
                    <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.75rem" }}>
                      {generationNote}
                    </p>
                  )}
                </>
              )}
            </div>

            {loading ? (
              <p className="muted">Carregando…</p>
            ) : (
              <>
                <label style={{ display: "block", marginBottom: "0.75rem" }}>
                  <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                    Título da página (Title Tag)
                  </span>
                  <input
                    type="text"
                    value={seoTitle}
                    onChange={(e) => setSeoTitle(e.target.value)}
                    maxLength={500}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", marginBottom: "0.75rem" }}>
                  <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                    Descrição (meta tag de descrição)
                  </span>
                  <textarea
                    value={metaDescription}
                    onChange={(e) => setMetaDescription(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    style={FIELD_TEXTAREA_STYLE}
                  />
                </label>
                <label style={{ display: "block", marginBottom: "0.75rem" }}>
                  <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                    Palavras similares / keywords (separadas por vírgula)
                  </span>
                  <input
                    type="text"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    maxLength={500}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block" }}>
                  <span className="muted" style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
                    URL real da página{" "}
                    {pageType === "brand"
                      ? "(obrigatória para medir Impacto — a VTEX não expõe URL de marca automaticamente)"
                      : "(opcional — detectada automaticamente na sincronização de categorias; preencha só para corrigir)"}
                  </span>
                  <input
                    type="url"
                    value={pageUrl}
                    onChange={(e) => setPageUrl(e.target.value)}
                    placeholder="https://www.sualoja.com.br/..."
                    style={{ width: "100%" }}
                  />
                </label>
              </>
            )}
          </section>
        )}

        {!isUnavailable && !loading && (
          <section className="card" style={{ marginTop: "1.5rem" }}>
            <h2 style={{ marginTop: 0 }}>Prévia (resultado de busca)</h2>
            <div style={{ maxWidth: 560, fontFamily: "arial, sans-serif" }}>
              <div style={{ color: "#8ab4f8", fontSize: "1.05rem", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {seoTitle || `(sem título) — ${isDefaultScope ? defaultLabel : scopeKey}`}
              </div>
              <div className="muted" style={{ fontSize: "0.78rem", margin: "0.15rem 0" }}>
                {platform === "vtex" ? "www.sualoja.com.br" : "sualoja.myshopify.com"} › ...
              </div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {metaDescription || "(sem descrição)"}
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
