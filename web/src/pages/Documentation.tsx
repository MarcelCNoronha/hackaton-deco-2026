import { Link } from "react-router-dom";

interface DocEntry {
  title: string;
  description: string;
  liveRoute?: { label: string; to: string };
  repoPath?: string;
  artifactUrl?: string;
}

const DOCS: DocEntry[] = [
  {
    title: "Diagrama de arquitetura",
    description:
      "Fluxo completo do pipeline multi-agente (Analyst → Content Enrichment ↔ Evaluator → Publisher), incluindo os " +
      "dois ciclos de auto-correção (conteúdo e imagem).",
    liveRoute: { label: "Ver aba Arquitetura", to: "/architecture" },
    repoPath: "web/src/lib/architecture-diagram.ts",
    artifactUrl: "https://claude.ai/code/artifact/127e33b6-2099-4365-80a9-5ecc284a173e",
  },
  {
    title: "Referência de APIs",
    description:
      "Toda operação externa que o pipeline chama — VTEX, Shopify, Google Search Console, GA4, Claude, OpenAI, " +
      "Gemini — campo a campo, com as ressalvas relevantes (ex: o bug do PUT não-parcial da VTEX).",
    liveRoute: { label: "Ver aba Arquitetura", to: "/architecture" },
    repoPath: "web/src/lib/api-reference.ts",
    artifactUrl: "https://claude.ai/code/artifact/1adde460-c296-4117-9dd7-73ccb528ac7c",
  },
  {
    title: "Exemplo de PDP — nível Excelente",
    description:
      "Mockup de uma página de produto real (porcelanato) mostrando o que o nível Excelente gera, com etiquetas " +
      "indicando qual campo do CatalogIA preenche cada bloco.",
    repoPath: "docs/exemplos/pdp-nivel-excelente.html",
    artifactUrl: "https://claude.ai/code/artifact/5a74c69b-9f5d-434b-a6e4-5808ab236cd6",
  },
];

/** Índice dos materiais de documentação gerados durante o desenvolvimento — cada item tem uma
 *  fonte viva no repositório (atualizada junto do código) e, quando aplicável, uma cópia
 *  publicada como Artifact para o vídeo/pitch. Ver também docs/README.md no repositório. */
export function Documentation() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Documentação</h1>
          <p className="muted">
            Material de apoio gerado durante o desenvolvimento — cada item tem uma fonte viva no repositório
            (atualizada junto do código, ver <code>docs/README.md</code>) e, quando aplicável, uma cópia publicada
            como Artifact para o vídeo/pitch.
          </p>
        </div>
      </div>

      <div className="page-content">
        {DOCS.map((doc) => (
          <section className="card" key={doc.title}>
            <h3 style={{ marginTop: 0 }}>{doc.title}</h3>
            <p className="muted" style={{ marginTop: 0 }}>{doc.description}</p>
            <div className="actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
              {doc.liveRoute && (
                <Link className="link-button" to={doc.liveRoute.to}>
                  {doc.liveRoute.label} →
                </Link>
              )}
              {doc.artifactUrl && (
                <a className="link-button" href={doc.artifactUrl} target="_blank" rel="noreferrer">
                  Ver Artifact publicado ↗
                </a>
              )}
            </div>
            {doc.repoPath && (
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: "0.5rem", marginBottom: 0 }}>
                Fonte: <code>{doc.repoPath}</code>
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
