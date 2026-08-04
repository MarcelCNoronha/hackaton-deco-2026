/** Single source of truth for the "Arquitetura" page's diagram — update this whenever an agent,
 *  loop, or data source changes, instead of redrawing anything by hand. Mirrors the diagram
 *  published as a standalone Artifact for the hackathon pitch; keep both in sync when this changes. */
export const ARCHITECTURE_DIAGRAM = `flowchart TB
  subgraph fontes["Fontes de dados"]
    vtex["VTEX / Shopify — catálogo"]
    gsc["Google Search Console"]
    ga4["Google Analytics 4"]
  end

  subgraph pipeline["Pipeline multi-agente"]
    cr["Catalog Reader — sincroniza produtos"]
    an["Analyst — prioriza por sinais de GSC/GA4"]
    ce["Content Enrichment — nível Médio / Bom / Excelente"]
    ev["Evaluator — score composto de 11 métricas"]
    ig["Image Generation — lifestyle / feature callout"]
    iv["Gate de integridade — mesmo produto?"]
    alt["Image Alt-Text"]
  end

  subgraph humano["Revisão humana"]
    rev["Aprovar, editar ou rejeitar cada proposta"]
  end

  subgraph saida["Publicação e medição"]
    tpl["Configuração de PDP — blocos e ordem por plataforma/nível"]
    pub["Publisher — monta o HTML final a partir do template"]
    thr["Classificação por categoria — Excelente / Bom / Médio"]
    imp["Impacto Estimado — SEO, GEO, conversão, completude, tempo economizado"]
  end

  vtex --> cr
  gsc --> an
  ga4 --> an
  cr --> an
  an -- "produtos priorizados" --> ce
  ce -- "draft" --> ev
  ev -- "feedback: perguntas sem resposta, alegações não sustentadas" --> ce
  ev -- "score final atinge a nota mínima" --> rev

  cr --> ig
  ig --> iv
  iv -- "reprovado, tenta de novo (até 2x)" --> ig
  iv -- "aprovado" --> rev

  cr --> alt
  alt --> rev

  rev -- "aprovado" --> pub
  tpl -- "ordem dos blocos" --> pub
  pub --> vtex

  ev --> thr
  ev --> imp
`;

export const ARCHITECTURE_NOTES: Array<{ title: string; body: string }> = [
  {
    title: "Content Enrichment ↔ Evaluator",
    body:
      "O conteúdo gerado nunca vai direto pra revisão humana sem passar por um julgamento na régua fixa " +
      "(comprador simulado + perguntas GEO + SEO/conversão/consistência) — até 3 tentativas, sempre ficando " +
      "com a melhor pontuação vista, nunca a última se ela for pior.",
  },
  {
    title: "Image Generation ↔ Gate de integridade",
    body:
      "Nenhuma imagem gerada por IA é aceita sem uma segunda chamada independente confirmando que é o mesmo " +
      "produto (mesma forma/cor/material/rótulo) — só cenário, enquadramento e iluminação podem mudar. " +
      "Reprovada, tenta de novo (até 2x); esgotado, fica marcada como não verificada em vez de publicada " +
      "silenciosamente.",
  },
  {
    title: "Evaluator → Classificação + Impacto",
    body:
      "O mesmo score composto alimenta tanto o badge Excelente/Bom/Médio (limites configuráveis por " +
      "categoria) quanto o banner de Impacto Estimado (deltas antes/depois agregados por run ou pra conta " +
      "toda).",
  },
  {
    title: "Configuração de PDP → Publisher",
    body:
      "A IA nunca decide estrutura HTML — só gera dados por campo (texto, lista de bullets, tabela de specs, " +
      "FAQ, CTA, foto de destaque). Quem decide quais desses blocos aparecem, em que ordem, e por " +
      "plataforma/nível (Médio renderiza tudo como texto corrido; Bom/Excelente usam HTML semântico real) é " +
      "o template configurado em 'Configuração de PDP' — o Publisher só executa esse template no momento da " +
      "publicação, nunca improvisa.",
  },
];
