import { useEffect, useState } from "react";
import {
  api,
  DEFAULT_PDP_CATEGORY,
  PDP_ALIGN_OPTIONS,
  PDP_BLOCKS,
  PDP_FONT_SIZE_OPTIONS,
  type CatalogPlatform,
  type CategorySpecFields,
  type CategoryTreeNode,
  type DescriptionRichness,
  type PdpBlock,
  type PdpFontSize,
  type PdpLayoutCell,
  type PdpLayoutRow,
  type PdpTemplate,
  type PdpTextAlign,
} from "../api/client";

const BLOCK_LABELS: Record<PdpBlock, string> = {
  description: "Descrição (texto corrido)",
  benefit_bullets: "Bullets de benefício",
  technical_specs: "Especificações técnicas",
  featured_image: "Foto de destaque",
  ambient_photo: "Foto ambientada",
  faq: "FAQ",
  cta: "Chamada à ação (CTA)",
};

const ALIGN_LABELS: Record<PdpTextAlign, string> = {
  justify: "Justificado",
  left: "Esquerda",
  right: "Direita",
  center: "Centralizado",
};

const FONT_SIZE_LABELS: Record<PdpFontSize, string> = { sm: "Pequeno", md: "Normal", lg: "Grande" };

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
    "Igual ao Bom, mais os blocos 'Foto de destaque'/'Foto ambientada' disponíveis — só aparecem quando a IA de fato escolheu uma foto pra esse produto.",
};

function defaultCell(usedBlocks: Set<PdpBlock>): PdpLayoutCell {
  const block = PDP_BLOCKS.find((b) => !usedBlocks.has(b)) ?? PDP_BLOCKS[0];
  return { block, align: "justify", bold: false, fontSize: "md" };
}

/** Starting point for a category/level that was only ever configured the old, flat way (or never
 *  configured at all) — one block per row, in order, with neutral styling. Lets every existing
 *  template open straight into the layout editor instead of forcing a "migrate first" step. */
function blocksToLayout(blocks: PdpBlock[]): PdpLayoutRow[] {
  return blocks.map((block) => ({ columns: [{ block, align: "justify" as PdpTextAlign, bold: false, fontSize: "md" as PdpFontSize }] }));
}

/** The inverse — flattened left-to-right, top-to-bottom, deduped — kept only as the legacy
 *  `blocks` field the API still stores alongside `layout` (fallback rendering + the "description is
 *  required somewhere" check), never used to actually assemble the HTML once `layout` is set. */
function flattenLayout(layout: PdpLayoutRow[]): PdpBlock[] {
  const seen = new Set<PdpBlock>();
  const out: PdpBlock[] = [];
  for (const row of layout) {
    for (const cell of row.columns) {
      if (seen.has(cell.block)) continue;
      seen.add(cell.block);
      out.push(cell.block);
    }
  }
  return out;
}

/** Wraps the server-rendered block HTML (via renderPdp — the exact same function that actually
 *  publishes) in a mock PDP shell, so the preview reads as "a real product page", not a bare HTML
 *  dump. Rendered inside an iframe (srcDoc) for full style isolation from the app. */
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

  const [layoutByLevel, setLayoutByLevel] = useState<Record<DescriptionRichness, PdpLayoutRow[]>>({
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

  const leafNodes = categoryNodes.filter((n) => n.isLeaf);
  const isSpecificCategory = selectedCategory !== DEFAULT_PDP_CATEGORY;

  function loadCategoryFields() {
    api.getCategoryNodes().then(({ nodes }) => setCategoryNodes(nodes));
    api.getCategorySpecFields().then(({ categories }) => setCategorySpecFields(categories));
  }

  function loadTemplatesForCategory(category: string) {
    api.getPdpTemplates(category).then(({ platform, templates }) => {
      setPlatform(platform);
      setLayoutByLevel(
        Object.fromEntries(templates.map((t) => [t.level, t.layout?.length ? t.layout : blocksToLayout(t.blocks)])) as Record<
          DescriptionRichness,
          PdpLayoutRow[]
        >,
      );
      setTemplateSource(Object.fromEntries(templates.map((t) => [t.level, t.source])) as Record<DescriptionRichness, PdpTemplate["source"]>);
      setLoading(false);
    });
  }

  useEffect(() => {
    loadCategoryFields();
  }, []);

  useEffect(() => {
    setMessage(null);
    loadTemplatesForCategory(selectedCategory);
  }, [selectedCategory]);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const layout = layoutByLevel[activeLevel];
    api.previewPdpTemplate({ level: activeLevel, blocks: flattenLayout(layout), layout }).then(({ html }) => {
      if (!cancelled) setPreviewHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [activeLevel, layoutByLevel, loading]);

  function updateRows(updater: (rows: PdpLayoutRow[]) => PdpLayoutRow[]) {
    setLayoutByLevel((prev) => ({ ...prev, [activeLevel]: updater(prev[activeLevel]) }));
  }

  function moveRow(index: number, direction: -1 | 1) {
    updateRows((rows) => {
      const target = index + direction;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addRow() {
    updateRows((rows) => {
      const used = new Set(rows.flatMap((r) => r.columns.map((c) => c.block)));
      return [...rows, { columns: [defaultCell(used)] }];
    });
  }

  function removeRow(index: number) {
    updateRows((rows) => rows.filter((_, i) => i !== index));
  }

  function addColumn(rowIndex: number) {
    updateRows((rows) => {
      if (rows[rowIndex].columns.length >= 2) return rows;
      const used = new Set(rows.flatMap((r) => r.columns.map((c) => c.block)));
      const next = [...rows];
      next[rowIndex] = { columns: [...next[rowIndex].columns, defaultCell(used)] };
      return next;
    });
  }

  function removeColumn(rowIndex: number, colIndex: number) {
    updateRows((rows) => {
      const columns = rows[rowIndex].columns.filter((_, i) => i !== colIndex);
      const next = [...rows];
      if (columns.length === 0) next.splice(rowIndex, 1);
      else next[rowIndex] = { columns };
      return next;
    });
  }

  function updateCell(rowIndex: number, colIndex: number, patch: Partial<PdpLayoutCell>) {
    updateRows((rows) => {
      const next = [...rows];
      const columns = [...next[rowIndex].columns];
      columns[colIndex] = { ...columns[colIndex], ...patch };
      next[rowIndex] = { columns };
      return next;
    });
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

  async function handleSave() {
    setSaving(activeLevel);
    setMessage(null);
    try {
      const layout = layoutByLevel[activeLevel];
      const { templates } = await api.setPdpTemplate({
        level: activeLevel,
        blocks: flattenLayout(layout),
        category: selectedCategory,
        layout,
      });
      setLayoutByLevel(
        Object.fromEntries(templates.map((t) => [t.level, t.layout?.length ? t.layout : blocksToLayout(t.blocks)])) as Record<
          DescriptionRichness,
          PdpLayoutRow[]
        >,
      );
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

  const rows = layoutByLevel[activeLevel];
  const selectedSpecFields = categorySpecFields.find((c) => c.categoryPath === selectedCategory);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Configuração de PDP</h1>
          <p className="muted">
            Escolha uma subcategoria (ou categoria, quando ela não tem subcategoria) e defina, só pra ela, os campos
            aceitos pela VTEX e a estrutura do anúncio nos 3 níveis — Médio, Bom e Excelente (a única coisa que muda
            entre eles é o formato da descrição). Vale pra plataforma ativa hoje:{" "}
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
            Tudo abaixo (campos aceitos, estrutura do anúncio) é configurado pra esta seleção. "Todas as categorias
            (padrão)" vale pra qualquer subcategoria sem configuração própria.
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

            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1rem", alignItems: "start" }}>
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
                <p className="muted" style={{ marginTop: 0, fontSize: "0.78rem" }}>
                  Cada linha vira uma seção da descrição. Uma linha com 2 colunas renderiza lado a lado (uma ao lado
                  da outra); cada bloco tem seu próprio alinhamento, negrito e tamanho de letra.
                </p>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginBottom: "0.75rem" }}>
                  {rows.map((row, ri) => (
                    <div key={ri} style={{ padding: "0.6rem", background: "var(--surface-2)", borderRadius: "var(--radius-sm)" }}>
                      <div className="proposal-header" style={{ marginBottom: "0.5rem" }}>
                        <span className="muted" style={{ fontFamily: "monospace" }}>
                          Linha {ri + 1}
                        </span>
                        <div style={{ display: "flex", gap: "0.3rem" }}>
                          <button type="button" className="secondary" onClick={() => moveRow(ri, -1)} disabled={ri === 0}>
                            ↑
                          </button>
                          <button type="button" className="secondary" onClick={() => moveRow(ri, 1)} disabled={ri === rows.length - 1}>
                            ↓
                          </button>
                          {row.columns.length < 2 && (
                            <button type="button" className="secondary" onClick={() => addColumn(ri)}>
                              + coluna
                            </button>
                          )}
                          <button type="button" className="secondary" onClick={() => removeRow(ri)}>
                            Remover linha
                          </button>
                        </div>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: row.columns.length === 2 ? "1fr 1fr" : "1fr",
                          gap: "0.6rem",
                        }}
                      >
                        {row.columns.map((cell, ci) => (
                          <div
                            key={ci}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.4rem",
                              padding: "0.5rem",
                              background: "var(--surface)",
                              borderRadius: "var(--radius-sm)",
                            }}
                          >
                            <select value={cell.block} onChange={(e) => updateCell(ri, ci, { block: e.target.value as PdpBlock })}>
                              {PDP_BLOCKS.map((b) => (
                                <option key={b} value={b}>
                                  {BLOCK_LABELS[b]}
                                </option>
                              ))}
                            </select>
                            <select value={cell.align} onChange={(e) => updateCell(ri, ci, { align: e.target.value as PdpTextAlign })}>
                              {PDP_ALIGN_OPTIONS.map((a) => (
                                <option key={a} value={a}>
                                  {ALIGN_LABELS[a]}
                                </option>
                              ))}
                            </select>
                            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                                <input
                                  type="checkbox"
                                  checked={cell.bold}
                                  onChange={(e) => updateCell(ri, ci, { bold: e.target.checked })}
                                />
                                Negrito
                              </label>
                              <select value={cell.fontSize} onChange={(e) => updateCell(ri, ci, { fontSize: e.target.value as PdpFontSize })}>
                                {PDP_FONT_SIZE_OPTIONS.map((s) => (
                                  <option key={s} value={s}>
                                    {FONT_SIZE_LABELS[s]}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {row.columns.length > 1 && (
                              <button type="button" className="secondary" onClick={() => removeColumn(ri, ci)}>
                                Remover coluna
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {rows.length === 0 && <p className="muted" style={{ margin: 0 }}>Nenhuma linha incluída ainda.</p>}
                </div>

                <div className="actions" style={{ justifyContent: "flex-start" }}>
                  <button type="button" className="secondary" onClick={addRow}>
                    + Adicionar linha
                  </button>
                </div>
              </section>

              <section className="card" style={{ padding: 0, overflow: "hidden", position: "sticky", top: "1rem" }}>
                <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
                  <h3 style={{ margin: 0 }}>Preview</h3>
                  <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.78rem" }}>
                    Conteúdo de exemplo — mostra só como as linhas/colunas ficariam montadas.
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
