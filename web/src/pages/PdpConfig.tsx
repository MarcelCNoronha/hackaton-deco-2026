import { useEffect, useState } from "react";
import { api, PDP_BLOCKS, type CatalogPlatform, type DescriptionRichness, type PdpBlock } from "../api/client";

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
  const [blocksByLevel, setBlocksByLevel] = useState<Record<DescriptionRichness, PdpBlock[]>>({
    plain: [],
    structured: [],
    structured_with_image: [],
  });
  const [activeLevel, setActiveLevel] = useState<DescriptionRichness>("plain");
  const [saving, setSaving] = useState<DescriptionRichness | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string>("");

  useEffect(() => {
    api.getPdpTemplates().then(({ platform, templates }) => {
      setPlatform(platform);
      setBlocksByLevel(Object.fromEntries(templates.map((t) => [t.level, t.blocks])) as Record<DescriptionRichness, PdpBlock[]>);
      setLoading(false);
    });
  }, []);

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
      const { templates } = await api.setPdpTemplate({ level: activeLevel, blocks: blocksByLevel[activeLevel] });
      setBlocksByLevel(Object.fromEntries(templates.map((t) => [t.level, t.blocks])) as Record<DescriptionRichness, PdpBlock[]>);
      setMessage(`Estrutura do nível ${LEVEL_LABELS[activeLevel]} salva.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  const blocks = blocksByLevel[activeLevel];
  const available = PDP_BLOCKS.filter((b) => !blocks.includes(b));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Configuração de PDP</h1>
          <p className="muted">
            Define exatamente quais blocos entram na descrição e em que ordem, por nível — a IA só gera dados por
            campo, nunca decide estrutura; isso aqui é o que decide. Vale pra plataforma ativa hoje:{" "}
            <strong>{platform === "vtex" ? "VTEX" : "Shopify"}</strong>.
          </p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}
        {loading && <p className="muted">Carregando…</p>}

        {!loading && (
          <>
            <div className="actions" style={{ justifyContent: "flex-start", marginBottom: "1rem" }}>
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
