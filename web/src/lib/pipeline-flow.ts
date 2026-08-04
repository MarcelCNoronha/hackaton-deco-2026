/** Narrativa viva do fluxo ponta a ponta — atualizar sempre que uma etapa do pipeline mudar,
 *  mesma disciplina de architecture-diagram.ts/api-reference.ts. Renderizado na aba Arquitetura,
 *  complementando o diagrama (visual) e a referência de APIs (campo a campo) com o "como isso
 *  tudo se encaixa" em prosa. */

export interface FlowStage {
  title: string;
  steps: string[];
}

export const PIPELINE_FLOW: FlowStage[] = [
  {
    title: "1. Setup (uma vez, painel Integrações)",
    steps: [
      "Conecta VTEX ou Shopify (só uma plataforma ativa por vez), Google (GSC+GA4), e um ou mais provedores de IA (Claude/OpenAI/Gemini).",
      "Roteamento de modelos: escolhe qual provedor/modelo roda cada tarefa (Enriquecimento, Alt-text, Evaluator).",
      "Padrões de Otimização: limites de score que classificam um produto como Ouro/Prata/Bronze, por categoria " +
        "(vocabulário deliberadamente diferente do nível Médio/Bom/Excelente escolhido antes de gerar — os dois podem discordar).",
      "Configuração de PDP: quais blocos (bullets, specs, FAQ, CTA, foto de destaque) entram na descrição e em que ordem, por nível.",
    ],
  },
  {
    title: "2. Criar uma otimização (tela Produtos)",
    steps: [
      "Escolhe os produtos (manual ou filtro + Top N).",
      "Nível (Médio/Bom/Excelente) — define descriptionRichness e mostra o custo previsto do pacote.",
      "Tom de comunicação (opcional).",
      "Quais dos 11 campos gerar + alt-text + geração de imagem por IA (sempre opt-in em qualquer nível).",
    ],
  },
  {
    title: "3. O run em si (fila BullMQ, orquestrador)",
    steps: [
      "Catalog Reader sincroniza os produtos escolhidos da plataforma ativa.",
      "Analyst prioriza por sinais de GSC/GA4 (casamento por URL) se o Top N cortar a lista, e expõe as top buscas reais de cada página (queryTopQueriesByPage).",
      "Content Enrichment chama o LLM roteado — consulta metafields conhecidos antes (Shopify), prioriza as buscas reais do Search Console pra essa página (quando existir) em vez de inventar palavras-chave, e usa visão real quando o nível pede imagem.",
      "Evaluator julga o rascunho na régua de 8 sub-scores (SEO, GEO, conversão, legibilidade, estrutura, confiança do comprador, completude, consistência); se não bate a nota mínima, volta com feedback pro LLM, até 3 tentativas, sempre guardando a melhor.",
      "Produto muito parecido com outro já aprovado reaproveita o conteúdo (RAG) em vez de gastar as 3 tentativas.",
      "Image Alt-Text roda separado, por imagem.",
      "Geração de imagem por IA (se marcada): gera + gate de integridade (segunda IA confirma que é o mesmo produto; reprovado, tenta de novo até 2x; esgotado, salva mas marca como não verificado).",
    ],
  },
  {
    title: "4. Revisão humana (RunDetail)",
    steps: [
      "Cada campo gerado é uma proposta separada (aprovar/editar/rejeitar).",
      "Score antes→depois nos 8 sub-scores + score geral, badge de classificação (Ouro/Prata/Bronze), banner de Confiança de conteúdo (estimado por IA), fotos geradas (com aviso se a integridade não foi confirmada).",
    ],
  },
  {
    title: "5. Publicar",
    steps: [
      "Publisher busca o template de PDP certo (plataforma + categoria + nível) e monta a descrição final nessa ordem exata — texto corrido puro se Médio, HTML real se Bom/Excelente.",
      "SEO title/meta description → campo nativo da plataforma.",
      "Tags → Shopify (nativo); VTEX fica só no app.",
      "Dados estruturados/keywords → Shopify Metafields (namespace próprio).",
      "Atributos normalizados → casa com metafield existente no Shopify (mesma terminologia) ou cria um novo; VTEX fica só no app.",
      "Fotos geradas por IA → botão dedicado \"Publicar na loja\" (upload real como imagem do produto).",
    ],
  },
  {
    title: "6. Medir impacto",
    steps: [
      "Página Impacto: consulta ao vivo ao GSC/GA4 por produto (sem tabela de snapshot local) — janela antes da " +
        "primeira publicação vs. janela depois, pivotada no publishedAt real; só fica disponível ~14 dias após " +
        "publicar (tempo do Google refletir a mudança), antes disso mostra 'maturando'.",
      "Banner de Confiança de conteúdo (estimado por IA) fica separado — é instantâneo, mas é a mesma IA julgando seu próprio antes/depois.",
    ],
  },
];

export interface KnownRisk {
  title: string;
  body: string;
}

/** Avaliação honesta do estado atual (2026-08-05) — não é um roadmap de features, é o que
 *  precisa ser validado/endurecido antes da submissão, priorizado sobre escopo novo. */
export const KNOWN_RISKS: KnownRisk[] = [
  {
    title: "VTEX nunca foi testada contra uma conta real",
    body: "Todo o código VTEX (client, PUT corrigido, addProductImage, Search API) roda contra a loja real pela primeira vez só depois do token chegar — é o maior risco pro demo, porque é justamente a loja de verdade que será mostrada.",
  },
  {
    title: "Escrita de atributos/metafields só funciona no Shopify",
    body: "A feature mais recente (attributes_patch → metafield real, casando terminologia ou criando campo) não tem equivalente implementado na VTEX ainda — o diferencial mais novo não aparece com dado real a menos que seja estendido pra VTEX.",
  },
  {
    title: "Casamento de GSC/GA4 é só por URL",
    body: "Se a URL do produto não bater exatamente com o que o Google indexou, o produto não mostra dado de impacto real (SEO/receita) — falha silenciosa, sem aviso. Vale tanto pra priorização (Analyst) quanto pra comparação ao vivo da página Impacto.",
  },
  {
    title: "Score é auto-avaliado pela própria IA",
    body: "O Evaluator julga o que o Content Enrichment gerou — é rotulado como \"estimado\" no produto, mas vale ter pronta a resposta pra \"quem garante que essa nota significa algo real\". Mitigado por dois lados: o painel de Impacto real (GSC/GA4 ao vivo, ver Fluxo #6) é uma medida totalmente independente da IA; e o roteamento padrão agora usa provedores DIFERENTES pra Content Enrichment (Anthropic) e Evaluator (OpenAI) — reduz mas não elimina a circularidade, e uma instância já em produção antes dessa mudança precisa ajustar manualmente em Integrações → Roteamento de Modelos, já que uma linha salva no banco sobrepõe o novo default do código.",
  },
  {
    title: "Sem limite de concorrência entre produtos num run",
    body: "Todos os produtos de um run disparam chamadas de IA em paralelo sem limite — risco de custo/rate-limit conhecido, não testado sob carga real.",
  },
  {
    title: "Zero teste automatizado",
    body: "Tudo validado por type-check/build manual — sem rede de segurança se algo quebrar no meio de uma demo ao vivo.",
  },
];
