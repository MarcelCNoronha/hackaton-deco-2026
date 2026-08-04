import { useEffect, useState } from "react";
import {
  api,
  DEFAULT_PDP_CATEGORY,
  MAX_REFERENCE_LINKS,
  PDP_BLOCKS,
  type CatalogPlatform,
  type CategoryContentProfile,
  type CategoryReferenceLink,
  type CategorySpecFields,
  type CategoryTreeNode,
  type DescriptionRichness,
  type PdpBlock,
  type PdpTemplate,
} from "../api/client";

const PROFILE_SOURCE_LABELS: Record<CategoryContentProfile["source"], string> = {
  manual: "Definido manualmente",
  references: "Calculado a partir dos links de referência",
  internal: "Calculado a partir dos seus produtos já bem avaliados",
};

const BLOCK_LABELS: Record<PdpBlock, string> = {
  description: "Descrição (texto corrido)",
  benefit_bullets: "Bullets de benefício",
  technical_specs: "Especificações técnicas",
  featured_image: "Foto de destaque",
  faq: "FAQ",
  cta: "Chamada à ação (CTA)",
};

const LEVEL_ORDER: DescriptionRichness[] = ["plain", "structured", "structured_with_image"];
const LEVEL_LABELS: Record<DescriptionRichness, string> = {
  plain: "Médio",
  structured: "Bom",
  structured_with_image: "Excelente",
};
const LEVEL_HINT: Record<DescriptionRichness, string> = {
  plain: "Todo bloco marcado aqui renderiza como texto corrido — sem título, lista ou tabela.",
  structured: "Blocos marcados ganham HTML semântico real (títulos, listas, tabela de specs).",
  structured_with_image:
    "Igual ao Bom, mais o bloco 'Foto de destaque' disponível — só aparece quando a IA de fato escolheu uma foto pra esse produto.",
};

/** Wraps the server-rendered block HTML (via renderPdpHtml — the exact same function that
 *  actually publishes) in a mock PDP shell, so the preview reads as "a real product page", not a
 *  bare HTML dump. Rendered inside an iframe (srcDoc) for full style isolation from the app. */
function buildPreviewDoc(innerHtml: string, platform: CatalogPlatform): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f2f1ed; color: #23262b; font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
    main { max-width: 760px; margin: 0 auto; padding: 1.25rem 1.25rem 3rem; }
    .breadcrumb { font-size: 0.72rem; color: #6b7078; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
    .grid { display: grid; grid-template-columns: 220px 1fr; gap: 1.25rem; margin-bottom: 2rem; }
    .gallery { aspect-ratio: 1/1; border-radius: 10px; background: repeating-linear-gradient(135deg, #dcdad3 0 10px, #eae8e1 10px 20px); }
    h1 { font-size: 1.25rem; margin: 0 0 0.4rem; }
    .price { font-size: 1.4rem; font-weight: 800; margin: 0.4rem 0; }
    .cta-btn { display: block; width: 100%; text-align: center; background: #cb7c1c; color: #2a1c05; font-weight: 700; padding: 0.65rem; border-radius: 8px; margin-top: 0.75rem; }
    .desc-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7078; margin-bottom: 0.5rem; }
    .empty { color: #6b7078; font-style: italic; }
    p { margin: 0 0 0.85rem; }
    h2 { font-size: 1.05rem; margin: 1.4rem 0 0.6rem; }
    h3 { font-size: 0.95rem; margin: 1.1rem 0 0.3rem; }
    ul.catalogia-bullets { padding-left: 1.2rem; margin: 0 0 0.85rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; margin-bottom: 0.85rem; }
    td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #dcdad3; }
    figure.catalogia-featured-image { margin: 1rem 0; }
    figure.catalogia-featured-image img { max-width: 100%; border-radius: 8px; }
    figcaption { font-size: 0.8rem; color: #6b7078; margin-top: 0.3rem; }
    .catalogia-cta { background: #f6e2c2; padding: 0.75rem; border-radius: 8px; }
  </style></head><body>
    <main>
      <div class="breadcrumb">Categoria de exemplo · ${platform === "vtex" ? "VTEX" : "Shopify"}</div>
      <div class="grid">
        <div class="gallery"></div>
        <div>
          <h1>Nome do produto (exemplo)</h1>
          <div class="price">R$ 129,90</div>
          <div class="cta-btn">Adicionar ao carrinho</div>
        </div>
      </div>
      <div class="desc-title">Descrição</div>
      ${innerHtml || '<p class="empty">Nenhum bloco incluído — a descrição ficaria vazia.</p>'}
    </main>
  </body></html>`;
}

export function PdpConfig() {
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");
  const [categoryNodes, setCategoryNodes] = useState<CategoryTreeNode[]>([]);
  const [categorySpecFields, setCategorySpecFields] = useState<CategorySpecFields[]>([]);
  const [syncingCategories, setSyncingCategories] = useState(false);

  // Single selection driving every section below — the catalog-wide "*" default, or one leaf
  // category (subcategory, or category itself when it has no subcategory — see CategoryTreeNode's
  // isLeaf doc comment).
  const [selectedCategory, setSelectedCategory] = useState<string>(DEFAULT_PDP_CATEGORY);

  const [blocksByLevel, setBlocksByLevel] = useState<Record<DescriptionRichness, PdpBlock[]>>({
    plain: [],
    structured: [],
    structured_with_image: [],
  });
  const [templateSource, setTemplateSource] = useState<Record<DescriptionRichness, PdpTemplate["source"]>>({
    plain: "default",
    structured: "default",
    structured_with_image: "default",
  });
  const [activeLevel, setActiveLevel] = useState<DescriptionRichness>("plain");
  const [saving, setSaving] = useState<DescriptionRichness | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string>("");

  const [referenceLinks, setReferenceLinks] = useState<CategoryReferenceLink[]>([]);
  const [contentProfile, setContentProfile] = useState<CategoryContentProfile | null>(null);
  const [newLinkUrls, setNewLinkUrls] = useState<string[]>(Array(MAX_REFERENCE_LINKS).fill(""));
  const [addingLink, setAddingLink] = useState(false);
  const [dnaMessage, setDnaMessage] = useState<string | null>(null);
  const [manualEdit, setManualEdit] = useState<{
    wordCountMin: string;
    wordCountMax: string;
    bulletCount: string;
    hasFaq: boolean;
    hasSpecTable: boolean;
    hasWarrantySection: boolean;
  } | null>(null);

  const leafNodes = categoryNodes.filter((n) => n.isLeaf);
  const isSpecificCategory = selectedCategory !== DEFAULT_PDP_CATEGORY;

  function loadCategoryFields() {
    api.getCategoryNodes().then(({ nodes }) => setCategoryNodes(nodes));
    api.getCategorySpecFields().then(({ categories }) => setCategorySpecFields(categories));
  }

  function loadDnaForCategory(category: string) {
    if (category === DEFAULT_PDP_CATEGORY) {
      setReferenceLinks([]);
      setContentProfile(null);
      return;
    }
    api.getCategoryReferenceLinks(category).then(({ links }) => setReferenceLinks(links));
    api.getCategoryContentProfile(category).then(({ profile }) => setContentProfile(profile));
  }

  function loadTemplatesForCategory(category: string) {
    api.getPdpTemplates(category).then(({ platform, templates }) => {
      setPlatform(platform);
      setBlocksByLevel(Object.fromEntries(templates.map((t) => [t.level, t.blocks])) as Record<DescriptionRichness, PdpBlock[]>);
      setTemplateSource(Object.fromEntries(templates.map((t) => [t.level, t.source])) as Record<DescriptionRichness, PdpTemplate["source"]>);
      setLoading(false);
    });
  }

  useEffect(() => {
    loadCategoryFields();
  }, []);

  useEffect(() => {
    setManualEdit(null);
    setDnaMessage(null);
    setMessage(null);
    setNewLinkUrls(Array(MAX_REFERENCE_LINKS).fill(""));
    loadDnaForCategory(selectedCategory);
    loadTemplatesForCategory(selectedCategory);
  }, [selectedCategory]);

  const referenceSlotsLeft = MAX_REFERENCE_LINKS - referenceLinks.length;

  /** Sends every filled-in url as one request (see category-profiles.routes.ts's batch handler) —
   *  a url that fails to fetch/extract shows up in `errors` without losing the ones that worked. */
  async function handleAddReferenceLinks() {
    const urls = newLinkUrls.map((u) => u.trim()).filter(Boolean).slice(0, referenceSlotsLeft);
    if (urls.length === 0 || !isSpecificCategory) return;
    setAddingLink(true);
    setDnaMessage(null);
    try {
      const { errors, profile } = await api.addCategoryReferenceLinks({ category: selectedCategory, urls });
      setNewLinkUrls(Array(MAX_REFERENCE_LINKS).fill(""));
      setContentProfile(profile);
      const { links } = await api.getCategoryReferenceLinks(selectedCategory);
      setReferenceLinks(links);
      if (errors.length > 0) {
        setDnaMessage(errors.map((e) => `${e.url}: ${e.error}`).join(" | "));
      }
    } catch (err) {
      setDnaMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingLink(false);
    }
  }

  async function handleRemoveReferenceLink(id: number) {
    const { profile } = await api.removeCategoryReferenceLink(id, selectedCategory);
    setContentProfile(profile);
    const { links } = await api.getCategoryReferenceLinks(selectedCategory);
    setReferenceLinks(links);
  }

  function startManualEdit() {
    setManualEdit({
      wordCountMin: contentProfile?.wordCountMin != null ? String(contentProfile.wordCountMin) : "",
      wordCountMax: contentProfile?.wordCountMax != null ? String(contentProfile.wordCountMax) : "",
      bulletCount: contentProfile?.bulletCount != null ? String(contentProfile.bulletCount) : "",
      hasFaq: contentProfile?.hasFaq ?? false,
      hasSpecTable: contentProfile?.hasSpecTable ?? false,
      hasWarrantySection: contentProfile?.hasWarrantySection ?? false,
    });
  }

  async function handleSaveManualProfile() {
    if (!manualEdit || !isSpecificCategory) return;
    const { profile } = await api.setCategoryContentProfile({
      category: selectedCategory,
      wordCountMin: manualEdit.wordCountMin ? Number(manualEdit.wordCountMin) : null,
      wordCountMax: manualEdit.wordCountMax ? Number(manualEdit.wordCountMax) : null,
      bulletCount: manualEdit.bulletCount ? Number(manualEdit.bulletCount) : null,
      hasFaq: manualEdit.hasFaq,
      hasSpecTable: manualEdit.hasSpecTable,
      hasWarrantySection: manualEdit.hasWarrantySection,
    });
    setContentProfile(profile);
    setManualEdit(null);
  }

  async function handleSyncCategories() {
    setSyncingCategories(true);
    setMessage(null);
    try {
      await api.syncVtexCategories();
      setMessage(
        "Sincronização de categorias iniciada em segundo plano — a lista abaixo atualiza em alguns instantes, recarregue a página se não vir a mudança.",
      );
    } finally {
      setSyncingCategories(false);
    }
  }

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    api.previewPdpTemplate({ level: activeLevel, blocks: blocksByLevel[activeLevel] }).then(({ html }) => {
      if (!cancelled) setPreviewHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [activeLevel, blocksByLevel, loading]);

  function moveBlock(index: number, direction: -1 | 1) {
    setBlocksByLevel((prev) => {
      const blocks = [...prev[activeLevel]];
      const target = index + direction;
      if (target < 0 || target >= blocks.length) return prev;
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      return { ...prev, [activeLevel]: blocks };
    });
  }

  function toggleBlock(block: PdpBlock) {
    setBlocksByLevel((prev) => {
      const blocks = prev[activeLevel];
      const next = blocks.includes(block) ? blocks.filter((b) => b !== block) : [...blocks, block];
      return { ...prev, [activeLevel]: next };
    });
  }

  async function handleSave() {
    setSaving(activeLevel);
    setMessage(null);
    try {
      const { templates } = await api.setPdpTemplate({
        level: activeLevel,
        blocks: blocksByLevel[activeLevel],
        category: selectedCategory,
      });
      setBlocksByLevel(Object.fromEntries(templates.map((t) => [t.level, t.blocks])) as Record<DescriptionRichness, PdpBlock[]>);
      setTemplateSource(Object.fromEntries(templates.map((t) => [t.level, t.source])) as Record<DescriptionRichness, PdpTemplate["source"]>);
      setMessage(
        `Estrutura do nível ${LEVEL_LABELS[activeLevel]} salva para ${
          isSpecificCategory ? selectedCategory : "todas as categorias (padrão)"
        }.`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  const blocks = blocksByLevel[activeLevel];
  const available = PDP_BLOCKS.filter((b) => !blocks.includes(b));
  const selectedSpecFields = categorySpecFields.find((c) => c.categoryPath === selectedCategory);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Configuração de PDP</h1>
          <p className="muted">
            Escolha uma subcategoria (ou categoria, quando ela não tem subcategoria) e defina, só pra ela, os campos
            aceitos, o DNA de conteúdo e a estrutura do anúncio nos 3 níveis — Médio, Bom e Excelente (a única coisa
            que muda entre eles é o formato da descrição). Vale pra plataforma ativa hoje:{" "}
            <strong>{platform === "vtex" ? "VTEX" : "Shopify"}</strong>.
          </p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}

        <section className="card">
          <div className="proposal-header">
            <h2 style={{ margin: 0 }}>Grupo de produtos</h2>
            {platform === "vtex" && (
              <button type="button" className="secondary" onClick={handleSyncCategories} disabled={syncingCategories}>
                {syncingCategories ? "Sincronizando…" : "Sincronizar categorias agora"}
              </button>
            )}
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Tudo abaixo (campos aceitos, DNA de conteúdo, estrutura do anúncio) é configurado pra esta seleção.
            "Todas as categorias (padrão)" vale pra qualquer subcategoria sem configuração própria.
          </p>
          <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)}>
            <option value={DEFAULT_PDP_CATEGORY}>Todas as categorias (padrão)</option>
            {leafNodes.map((n) => (
              <option key={n.path} value={n.path}>
                {n.path}
              </option>
            ))}
          </select>
          {platform === "vtex" && leafNodes.length === 0 && (
            <p className="muted" style={{ marginTop: "0.75rem" }}>
              Nenhuma subcategoria sincronizada ainda — clique em "Sincronizar categorias agora" ou reconecte a loja
              VTEX pra poder configurar por categoria.
            </p>
          )}
        </section>

        {platform === "vtex" && (
          <section className="card" style={{ marginTop: "1.5rem" }}>
            <h2>Campos aceitos pela VTEX</h2>
            {!isSpecificCategory && (
              <p className="muted">
                Este bloco é por subcategoria — selecione uma acima pra ver quais especificações a VTEX aceita nela.
              </p>
            )}
            {isSpecificCategory && (
              <>
                <p className="muted">
                  Especificações de produto que a VTEX aceita em <strong>{selectedCategory}</strong> — a IA usa essa
                  lista como referência do que pode ser preenchido, nunca inventando um campo fora dela.
                </p>
                <div style={{ padding: "0.6rem 0.85rem", background: "var(--surface-2)", borderRadius: "var(--radius-sm)" }}>
                  {selectedSpecFields && selectedSpecFields.fields.length > 0
                    ? selectedSpecFields.fields.map((f) => f.name).join(", ")
                    : "Nenhum campo de especificação configurado nesta categoria no admin da VTEX."}
                </div>
              </>
            )}
          </section>
        )}

        {platform === "vtex" && isSpecificCategory && (
          <section className="card" style={{ marginTop: "1.5rem" }}>
            <h2>DNA de conteúdo</h2>
            <p className="muted">
              Alvo estrutural (tamanho de descrição, bullets, FAQ, tabela de specs, garantia) usado como referência de
              qualidade na geração pra <strong>{selectedCategory}</strong> — nunca copia texto de terceiros, só a
              estrutura. Prioridade: valor definido manualmente &gt; consenso dos links de referência &gt; calculado a
              partir dos seus próprios produtos bem avaliados.
            </p>

            {dnaMessage && <div className="banner">{dnaMessage}</div>}

            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1rem" }}>
              <div className="card" style={{ background: "var(--surface-2)" }}>
                <h3 style={{ marginTop: 0 }}>Links de referência</h3>
                <p className="muted" style={{ fontSize: "0.82rem" }}>
                  Cole até {MAX_REFERENCE_LINKS} anúncios de referência dessa categoria (seus ou de mercado) —
                  extraímos só a estrutura, nunca o texto. Todos os campos preenchidos são processados numa única
                  requisição; um link com problema (fora do ar, bloqueado, etc.) não impede os outros de entrar.
                </p>
                {referenceSlotsLeft > 0 && (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "0.5rem" }}>
                      {newLinkUrls.slice(0, referenceSlotsLeft).map((url, i) => (
                        <input
                          key={i}
                          type="url"
                          placeholder="https://..."
                          value={url}
                          onChange={(e) => setNewLinkUrls((prev) => prev.map((u, idx) => (idx === i ? e.target.value : u)))}
                        />
                      ))}
                    </div>
                    <div className="actions" style={{ justifyContent: "flex-start", marginBottom: "0.75rem" }}>
                      <button
                        type="button"
                        onClick={handleAddReferenceLinks}
                        disabled={addingLink || newLinkUrls.every((u) => !u.trim())}
                      >
                        {addingLink ? "Analisando…" : "Adicionar"}
                      </button>
                    </div>
                  </>
                )}
                {referenceSlotsLeft <= 0 && (
                  <p className="muted" style={{ fontSize: "0.82rem" }}>
                    Já tem {MAX_REFERENCE_LINKS} links de referência — remova um abaixo antes de adicionar outro.
                  </p>
                )}
                {referenceLinks.length === 0 && <p className="muted">Nenhum link de referência ainda.</p>}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {referenceLinks.map((link) => (
                    <div
                      key={link.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: "0.5rem",
                        padding: "0.4rem 0.6rem",
                        background: "var(--surface)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {link.url}
                        </div>
                        {link.warning && (
                          <div className="muted" style={{ fontSize: "0.72rem" }}>
                            ⚠ {link.warning}
                          </div>
                        )}
                      </div>
                      <button type="button" className="secondary" onClick={() => handleRemoveReferenceLink(link.id)}>
                        Remover
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card" style={{ background: "var(--surface-2)" }}>
                <div className="proposal-header">
                  <h3 style={{ margin: 0 }}>Perfil calculado</h3>
                  {!manualEdit && (
                    <button type="button" className="secondary" onClick={startManualEdit}>
                      Editar manualmente
                    </button>
                  )}
                </div>

                {!manualEdit && (
                  <>
                    {!contentProfile && <p className="muted">Nenhum perfil calculado ainda para esta categoria.</p>}
                    {contentProfile && (
                      <>
                        <p className="muted" style={{ fontSize: "0.78rem" }}>{PROFILE_SOURCE_LABELS[contentProfile.source]}</p>
                        <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                          <li>
                            Palavras: {contentProfile.wordCountMin ?? "?"}–{contentProfile.wordCountMax ?? "?"}
                          </li>
                          <li>Bullets: {contentProfile.bulletCount ?? "?"}</li>
                          <li>FAQ: {contentProfile.hasFaq ? "Sim" : "Não"}</li>
                          <li>Tabela de especificações: {contentProfile.hasSpecTable ? "Sim" : "Não"}</li>
                          <li>Seção de garantia: {contentProfile.hasWarrantySection ? "Sim" : "Não"}</li>
                        </ul>
                      </>
                    )}
                  </>
                )}

                {manualEdit && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <input
                        type="number"
                        placeholder="Mín. palavras"
                        value={manualEdit.wordCountMin}
                        onChange={(e) => setManualEdit({ ...manualEdit, wordCountMin: e.target.value })}
                      />
                      <input
                        type="number"
                        placeholder="Máx. palavras"
                        value={manualEdit.wordCountMax}
                        onChange={(e) => setManualEdit({ ...manualEdit, wordCountMax: e.target.value })}
                      />
                    </div>
                    <input
                      type="number"
                      placeholder="Nº de bullets"
                      value={manualEdit.bulletCount}
                      onChange={(e) => setManualEdit({ ...manualEdit, bulletCount: e.target.value })}
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={manualEdit.hasFaq}
                        onChange={(e) => setManualEdit({ ...manualEdit, hasFaq: e.target.checked })}
                      />{" "}
                      Incluir FAQ
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={manualEdit.hasSpecTable}
                        onChange={(e) => setManualEdit({ ...manualEdit, hasSpecTable: e.target.checked })}
                      />{" "}
                      Incluir tabela de especificações
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={manualEdit.hasWarrantySection}
                        onChange={(e) => setManualEdit({ ...manualEdit, hasWarrantySection: e.target.checked })}
                      />{" "}
                      Incluir seção de garantia
                    </label>
                    <div className="actions" style={{ justifyContent: "flex-start" }}>
                      <button type="button" onClick={handleSaveManualProfile}>
                        Salvar
                      </button>
                      <button type="button" className="secondary" onClick={() => setManualEdit(null)}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {loading && <p className="muted" style={{ marginTop: "1.5rem" }}>Carregando estrutura do anúncio…</p>}

        {!loading && (
          <>
            <div className="actions" style={{ justifyContent: "flex-start", marginTop: "1.5rem", marginBottom: "1rem" }}>
              {LEVEL_ORDER.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={level === activeLevel ? "" : "secondary"}
                  onClick={() => setActiveLevel(level)}
                >
                  {LEVEL_LABELS[level]}
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1rem" }}>
              <section className="card">
                <div className="proposal-header">
                  <h3 style={{ margin: 0 }}>{LEVEL_LABELS[activeLevel]}</h3>
                  <button type="button" onClick={handleSave} disabled={saving === activeLevel}>
                    {saving === activeLevel ? "Salvando…" : "Salvar"}
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem" }}>{LEVEL_HINT[activeLevel]}</p>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.78rem" }}>
                  {templateSource[activeLevel] === "specific"
                    ? `Estrutura própria de ${isSpecificCategory ? selectedCategory : "todas as categorias (padrão)"}.`
                    : isSpecificCategory
                      ? "Ainda sem estrutura própria — herdando o padrão geral. Salvar cria uma estrutura só pra esta categoria."
                      : "Estrutura de fábrica — ainda não personalizada."}
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "0.75rem" }}>
                  {blocks.map((block, i) => (
                    <div
                      key={block}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        padding: "0.5rem 0.75rem",
                        background: "var(--surface-2)",
                        borderRadius: "var(--radius-sm)",
                      }}
                    >
                      <span>
                        <span className="muted" style={{ fontFamily: "monospace", marginRight: "0.5rem" }}>
                          {i + 1}
                        </span>
                        {BLOCK_LABELS[block]}
                      </span>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button type="button" className="secondary" onClick={() => moveBlock(i, -1)} disabled={i === 0}>
                          ↑
                        </button>
                        <button type="button" className="secondary" onClick={() => moveBlock(i, 1)} disabled={i === blocks.length - 1}>
                          ↓
                        </button>
                        <button type="button" className="secondary" onClick={() => toggleBlock(block)}>
                          Remover
                        </button>
                      </div>
                    </div>
                  ))}
                  {blocks.length === 0 && <p className="muted" style={{ margin: 0 }}>Nenhum bloco incluído ainda.</p>}
                </div>

                {available.length > 0 && (
                  <div className="actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                    {available.map((block) => (
                      <button key={block} type="button" className="secondary" onClick={() => toggleBlock(block)}>
                        + {BLOCK_LABELS[block]}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
                  <h3 style={{ margin: 0 }}>Preview</h3>
                  <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.78rem" }}>
                    Conteúdo de exemplo — mostra só como os blocos ficariam montados.
                  </p>
                </div>
                <iframe
                  title="Preview da PDP"
                  srcDoc={buildPreviewDoc(previewHtml, platform)}
                  style={{ width: "100%", height: 520, border: "none" }}
                />
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
