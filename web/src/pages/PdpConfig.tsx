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

export function PdpConfig() {
  const [platform, setPlatform] = useState<CatalogPlatform>("vtex");
  const [blocksByLevel, setBlocksByLevel] = useState<Record<DescriptionRichness, PdpBlock[]>>({
    plain: [],
    structured: [],
    structured_with_image: [],
  });
  const [saving, setSaving] = useState<DescriptionRichness | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPdpTemplates().then(({ platform, templates }) => {
      setPlatform(platform);
      setBlocksByLevel(Object.fromEntries(templates.map((t) => [t.level, t.blocks])) as Record<DescriptionRichness, PdpBlock[]>);
      setLoading(false);
    });
  }, []);

  function moveBlock(level: DescriptionRichness, index: number, direction: -1 | 1) {
    setBlocksByLevel((prev) => {
      const blocks = [...prev[level]];
      const target = index + direction;
      if (target < 0 || target >= blocks.length) return prev;
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      return { ...prev, [level]: blocks };
    });
  }

  function toggleBlock(level: DescriptionRichness, block: PdpBlock) {
    setBlocksByLevel((prev) => {
      const blocks = prev[level];
      const next = blocks.includes(block) ? blocks.filter((b) => b !== block) : [...blocks, block];
      return { ...prev, [level]: next };
    });
  }

  async function handleSave(level: DescriptionRichness) {
    setSaving(level);
    setMessage(null);
    try {
      const { templates } = await api.setPdpTemplate({ level, blocks: blocksByLevel[level] });
      setBlocksByLevel(Object.fromEntries(templates.map((t) => [t.level, t.blocks])) as Record<DescriptionRichness, PdpBlock[]>);
      setMessage(`Estrutura do nível ${LEVEL_LABELS[level]} salva.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Configuração de PDP</h1>
          <p className="muted">
            Define exatamente quais blocos entram na descrição e em que ordem, por nível (Médio/Bom/Excelente) — a
            IA só gera dados por campo, nunca decide estrutura; isso aqui é o que decide. Vale pra plataforma ativa
            hoje: <strong>{platform === "vtex" ? "VTEX" : "Shopify"}</strong>.
          </p>
        </div>
      </div>

      <div className="page-content">
        {message && <div className="banner">{message}</div>}
        {loading && <p className="muted">Carregando…</p>}

        {!loading &&
          LEVEL_ORDER.map((level) => {
            const blocks = blocksByLevel[level];
            const available = PDP_BLOCKS.filter((b) => !blocks.includes(b));
            return (
              <section className="card" key={level} style={{ marginBottom: "1rem" }}>
                <div className="proposal-header">
                  <h3 style={{ margin: 0 }}>{LEVEL_LABELS[level]}</h3>
                  <button type="button" onClick={() => handleSave(level)} disabled={saving === level}>
                    {saving === level ? "Salvando…" : "Salvar"}
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 0, fontSize: "0.82rem" }}>{LEVEL_HINT[level]}</p>

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
                        <button type="button" className="secondary" onClick={() => moveBlock(level, i, -1)} disabled={i === 0}>
                          ↑
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => moveBlock(level, i, 1)}
                          disabled={i === blocks.length - 1}
                        >
                          ↓
                        </button>
                        <button type="button" className="secondary" onClick={() => toggleBlock(level, block)}>
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
                      <button key={block} type="button" className="secondary" onClick={() => toggleBlock(level, block)}>
                        + {BLOCK_LABELS[block]}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
      </div>
    </>
  );
}
