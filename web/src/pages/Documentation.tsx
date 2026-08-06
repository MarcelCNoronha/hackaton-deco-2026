import { Link } from "react-router";

interface DocEntry {
  title: string;
  description: string;
  liveRoute?: { label: string; to: string };
  repoPath?: string;
}

const DOCS: DocEntry[] = [
  {
    title: "Arquitetura",
    description:
      "Diagrama do pipeline multi-agente, o fluxo ponta a ponta em prosa (setup → run → revisão → publicar → " +
      "medir), e os riscos conhecidos que ainda precisam de validação.",
    liveRoute: { label: "Ver aba Arquitetura", to: "/architecture" },
    repoPath: "web/src/lib/{architecture-diagram,pipeline-flow}.ts",
  },
  {
    title: "Referência de APIs",
    description:
      "Toda operação externa que o pipeline chama — VTEX, Shopify, Google Search Console, GA4, Claude, OpenAI, " +
      "Gemini, Resend — campo a campo, uma aba por sistema.",
    liveRoute: { label: "Ver Referência de APIs", to: "/api-reference" },
    repoPath: "web/src/lib/api-reference.ts",
  },
];

/** Índice dos materiais de documentação gerados durante o desenvolvimento — cada item tem uma
 *  fonte viva no repositório, atualizada junto do código (ver docs/README.md). Sem links de
 *  Artifact: a aba Arquitetura no app é a versão mais completa e sempre atualizada, manter as
 *  duas em sincronia era a mesma duplicação que a auditoria de código morto tentou evitar. */
export function Documentation() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Documentação</h1>
          <p className="muted">
            Material de apoio gerado durante o desenvolvimento — cada item tem uma fonte viva no repositório,
            atualizada junto do código (ver <code>docs/README.md</code>).
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
