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
    ev["Evaluator — score composto (8 sub-scores)"]
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
    thr["Classificação por categoria — Ouro / Prata / Bronze"]
    conf["Confiança de conteúdo — score de IA, deltas instantâneos"]
    rimp["Impacto real — consulta ao vivo GSC/GA4, pivotada no 1º publish"]
  end

  vtex --> cr
  gsc --> an
  ga4 --> an
  cr --> an
  an -- "produtos priorizados, buscas reais por página" --> ce
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
  ev --> conf
  pub -- "publishedAt = corte antes/depois" --> rimp
  gsc -- "consulta ao vivo, sem cópia local" --> rimp
  ga4 -- "consulta ao vivo, sem cópia local" --> rimp
`;

export const ARCHITECTURE_NOTES: Array<{ title: string; body: string }> = [
  {
    title: "Content Enrichment ↔ Evaluator",
    body:
      "O conteúdo gerado nunca vai direto pra revisão humana sem passar por um julgamento na régua fixa " +
      "(comprador simulado + perguntas GEO + SEO/conversão/consistência) — até 3 tentativas, sempre ficando " +
      "com a melhor pontuação vista, nunca a última se ela for pior. Roteamento padrão usa provedores " +
      "diferentes pras duas tarefas (Anthropic gera, OpenAI avalia) — julgar com o mesmo modelo que escreveu " +
      "é mais circular do que um provedor independente julgando.",
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
    title: "Evaluator → Classificação + Confiança de conteúdo",
    body:
      "O mesmo score composto alimenta tanto o badge Ouro/Prata/Bronze (limites configuráveis por " +
      "categoria) quanto o banner de Confiança de conteúdo (deltas antes/depois agregados por run ou pra " +
      "conta toda) — deliberadamente NÃO chamado de 'Impacto': é a mesma IA julgando seu próprio antes/depois, " +
      "disponível na hora. O Impacto real (dados do Google) é uma coisa separada, ver abaixo.",
  },
  {
    title: "Impacto real — sem tabela de snapshot",
    body:
      "productMetrics foi removida: em vez de guardar uma cópia própria dos números do GSC/GA4, a página de " +
      "Impacto consulta o Google ao vivo, comparando uma janela antes da primeira publicação do produto com " +
      "uma janela depois — o pivô é o publishedAt real de enrichment_proposals. Como o Google leva cerca de " +
      "14 dias pra refletir uma mudança de conteúdo/SEO, a comparação só aparece depois desse prazo; antes " +
      "disso a página mostra 'maturando' em vez de um número de ruído.",
  },
  {
    title: "Concorrência limitada dentro do pipeline",
    body:
      "Content Enrichment, Image Alt-Text e Geração de Imagem cada um roda no máximo " +
      "ENRICHMENT_CONCURRENCY (padrão 5) produtos por vez (lib/concurrency.ts's mapWithConcurrency), " +
      "não mais todos de uma vez — reduz o risco de rajada de custo/rate-limit num run grande sem " +
      "mudar o resultado final (mesmo Promise.allSettled por fora, resultados na mesma ordem).",
  },
  {
    title: "Analyst → buscas reais por página",
    body:
      "Além de priorizar produtos, o Analyst expõe as top buscas reais do Search Console por URL " +
      "(queryTopQueriesByPage) pro Content Enrichment — o prompt de SEO passa a priorizar cobrir termos que " +
      "compradores de fato digitam, em vez de a IA inventar palavras-chave plausíveis.",
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
