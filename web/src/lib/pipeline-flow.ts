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
      "Ao conectar a VTEX, um job de fundo sincroniza a árvore de categorias (Departamento > Categoria > Subcategoria) " +
        "e, por Subcategoria (ou Categoria quando não há Subcategoria), quais campos de especificação a VTEX aceita — " +
        "consultado antes de gerar, pra nunca propor um atributo que a plataforma não tem onde salvar; re-sincronizável " +
        "a qualquer momento pelo botão 'Sincronizar categorias agora'.",
      "DNA de conteúdo por categoria (Configuração de PDP): alvo estrutural (faixa de palavras, nº de bullets, presença " +
        "de FAQ/tabela de specs/garantia) — vem de um valor definido manualmente, ou do consenso entre até 3 links de " +
        "anúncios de referência colados pelo usuário, processados numa única requisição (extrai só estrutura, nunca " +
        "copia texto; um link com problema não impede os outros), ou, na ausência dos dois, calculado a partir dos " +
        "próprios produtos já bem avaliados (Ouro/Prata) da categoria.",
    ],
  },
  {
    title: "2. Criar uma otimização (tela Produtos)",
    steps: [
      "Escolhe os produtos (manual ou filtro + Top N).",
      "Nível (Médio/Bom/Excelente) — define descriptionRichness e mostra o custo previsto do pacote.",
      "Tom de comunicação (opcional).",
      "Quais dos 11 campos gerar + alt-text + geração de imagem por IA (sempre opt-in em qualquer nível).",
      "Opcional, por produto: 'Referência do fabricante' — cola a URL da página oficial do fabricante daquele produto " +
        "específico; extrai fatos objetivos (specs, dimensões, material, garantia) como fonte primária contra " +
        "alucinação, ficando salva no produto até ser trocada/removida. Sem URL, a geração usa só os dados do próprio " +
        "produto (mais o DNA da categoria, que se aplica sempre).",
    ],
  },
  {
    title: "3. O run em si (fila BullMQ, orquestrador)",
    steps: [
      "Catalog Reader sincroniza os produtos escolhidos da plataforma ativa.",
      "Analyst prioriza por sinais de GSC/GA4 (casamento por URL) se o Top N cortar a lista, e expõe as top buscas reais de cada página (queryTopQueriesByPage).",
      "Content Enrichment chama o LLM roteado — consulta metafields conhecidos antes (Shopify), prioriza as buscas reais do Search Console pra essa página (quando existir) em vez de inventar palavras-chave, e usa visão real quando o nível pede imagem.",
      "Antes de gerar, resolve por categoria: os campos aceitos pela VTEX e o DNA de conteúdo (sempre aplicados); e, se o produto tiver uma referência de fabricante salva, os fatos extraídos dela (opcional) — os três entram no mesmo prompt como restrições/contexto, nunca substituindo os dados do próprio produto.",
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
    title: "VTEX — validada contra uma conta real (2026-08-04)",
    body: "getCategoryFieldDefinitions/listCategoryTree, o PUT de produto (Title/MetaTagDescription/KeyWords) e a Specification API (.../specificationvalue, escrita real de \"Características do Produto\") foram todos validados ao vivo contra a conta real da Mundial Acabamentos. Um bug real foi encontrado e revertido nesse processo: escrever uma especificação por FieldName (em vez de FieldId) casou/criou um campo ERRADO de mesmo nome em outro grupo, duplicando a especificação no produto — reproduzido, revertido, e confirmado que só FieldId é seguro. addProductImage segue não validado ao vivo.",
  },
  {
    title: "Escrita de atributos/technical_specs — real nas duas plataformas agora",
    body: "Shopify: metafields (já existia). VTEX (novo, 2026-08-04): updateProductSpecificationValues escreve na Specification API real — qualquer label de technical_specs/attributes_patch que bata com um campo aceito da categoria do produto vai pra aba \"Características do Produto\" de verdade, não só pro HTML mesclado da descrição. O que não bate com nenhum campo continua só em-app.",
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
    title: "Concorrência entre produtos num run — agora limitada, não eliminada",
    body: "Corrigido (2026-08-05): cada task (Content Enrichment, Alt-Text, geração de imagem) roda com no máximo ENRICHMENT_CONCURRENCY (padrão 5) produtos simultâneos em vez de todos de uma vez (lib/concurrency.ts's mapWithConcurrency). Reduz bastante o risco de estourar rate-limit/gastar em rajada, mas o valor default ainda não foi validado contra as cotas reais dos provedores conectados sob carga real.",
  },
  {
    title: "Teste automatizado — cobertura inicial, não abrangente",
    body: "Corrigido em parte (2026-08-05): vitest cobre a lógica pura de maior risco (cálculo do score composto, merge de completude de atributos, renderPdpHtml/escapeHtml, transições de estado do Impacto real, o limitador de concorrência) e roda no CI a cada push/PR. Ainda NÃO cobre: rotas HTTP (Fastify), os 3 clients de LLM, VtexClient/ShopifyClient (incluindo o fix do PUT não-parcial), nem nenhum teste de integração contra um Postgres real — ainda é uma rede de segurança parcial, não uma garantia ampla antes de uma demo ao vivo.",
  },
  {
    title: "Extração de referência (URL de mercado/fabricante) depende de HTML puro",
    body: "web-fetch.client.ts não usa navegador headless — só busca o HTML e retira tags/scripts. Páginas que carregam o conteúdo principal via JavaScript (SPA pesado) voltam com pouco texto; o usuário recebe um aviso explícito na UI em vez de uma falha silenciosa, mas a extração fica pior nesse caso. Sem cobertura automatizada ainda.",
  },
  {
    title: "~~Deploy de produção defasado~~ — resolvido (2026-08-04, 20:47)",
    body: "O commit que adiciona o sync de categorias VTEX, campos de especificação, DNA de conteúdo por categoria e referência de fabricante (9553aaf) passou no CI, mas o primeiro Deploy Production falhou no passo de upload pra VPS — timeout de conexão SSH pro runner do GitHub (bloqueio de rede transitório, mesmo sintoma já visto antes). Uma nova tentativa (push seguinte, fbe2093) implantou com sucesso — a VPS já roda a versão com as features desta seção.",
  },
];
