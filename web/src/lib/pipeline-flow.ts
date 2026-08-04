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
      "Analyst prioriza por sinais de GSC/GA4 (casamento por URL) se o Top N cortar a lista.",
      "Content Enrichment chama o LLM roteado — consulta metafields conhecidos antes (Shopify) e usa visão real quando o nível pede imagem.",
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
      "Score antes→depois nos 8 sub-scores + score geral, badge de classificação (Ouro/Prata/Bronze), banner de Impacto Estimado, fotos geradas (com aviso se a integridade não foi confirmada).",
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
    steps: ["Página Impacto: histórico real de GSC/GA4 por produto + banner agregado de Impacto Estimado pra conta toda."],
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
    body: "Se a URL do produto não bater exatamente com o que o Google indexou, o produto não mostra dado de impacto real (SEO/receita) — falha silenciosa, sem aviso.",
  },
  {
    title: "Score é auto-avaliado pela própria IA",
    body: "O Evaluator julga o que o Content Enrichment gerou — é rotulado como \"estimado\" no produto, mas vale ter pronta a resposta pra \"quem garante que essa nota significa algo real\".",
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
