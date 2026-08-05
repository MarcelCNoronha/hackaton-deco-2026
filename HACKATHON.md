# Agents for Commerce — Hackathon Deco

Fonte: https://hackathon.decocms.com/agents-for-commerce

## Sobre o evento

O Agents for Commerce é o hackathon da Deco para construir, em poucos dias, soluções
agênticas que resolvam problemas reais de uma operação de e-commerce de alto volume
(search, catálogo, performance, tráfego, etc.).

## Datas

- Início: 01/08/2026, 09:00
- Fim: 09/08/2026, 20:59
- Submissão até: 09/08/2026, 23:59

## Trilha (única): E-commerce

Escolha livre de frente e abordagem. Frentes sugeridas:

1. **Search & Discovery** — busca no site, autocomplete, ordenação de vitrine (PLP), recomendação
2. **✅ Catalog & Content** (frente escolhida) — enriquecimento de catálogo, descrição de produto, imagem, conteúdo de SEO
3. **Performance & Reliability** — velocidade de página, Core Web Vitals, correção automática de regressões
4. **SEO, GEO & Agentic Commerce** — SEO técnico, GEO (ser achado/comprado por IA), atendimento conversacional, checkout pelo agente
5. **Outros** — qualquer boa ideia de e-commerce fora das frentes acima

### Nossa frente: Catalog & Content

Foco em enriquecimento de catálogo, descrição de produto, imagem e conteúdo de SEO.

**Loja de teste:** mundialacabamentos.com.br — escolhida por conta do SEO: é loja própria, com propriedade já verificada no Google Search Console, o que dá acesso a dado real de impressões/cliques/posição e resolve a dúvida de API vs. scraping (acesso direto ao catálogo, sem depender de domínio de terceiros).

**APIs previstas:**
- **Google Search Console API** (obrigatória) — linha de base e (se der tempo) evolução de impressões/CTR/posição por página/query. Mostra apenas *visibilidade*, não venda.
- **Google Analytics (GA4) API** (obrigatória) — fecha a ponta que o GSC não cobre: conversão, receita por página de produto, tempo na página. Sem ela não dá pra provar impacto de negócio de verdade (só indício de SEO), e o critério "Impacto no Negócio" pede receita/custo.
- **Google Merchant Center API** (bônus, se sobrar tempo) — feed de produto que alimenta AI Overviews e Google Shopping com IA; reforça a narrativa de GEO (dados estruturados melhores no feed = melhor recomendação por IA), mas adiciona mais uma integração OAuth pra gerenciar.
- Descartados por ora: PageSpeed/Core Web Vitals (é a frente "Performance & Reliability", não a nossa) e Google Ads Keyword Planner (mídia paga, exige conta de Ads, fora do escopo orgânico).
- API de IA/LLM (Claude/Anthropic) — geração/enriquecimento de descrição, conteúdo de SEO, e possivelmente análise de imagem (alt-text)
- **VTEX Catalog API** — mundialacabamentos.com.br roda em VTEX; leitura e escrita de produtos, SKUs, descrições, imagens e atributos do catálogo

**Extensão para GEO (Generative Engine Optimization):** além de SEO tradicional, otimizar o conteúdo do catálogo para ser encontrado/recomendado por IAs (ChatGPT, Perplexity, agentes de compra) — reforça o critério de Originalidade. Na prática:
- Descrições em linguagem natural mais completas/factuais (responder "serve pra quê", "compatível com o quê", diferenciais), não só palavras-chave
- Dados estruturados (schema.org/Product, FAQ) fáceis de parsear por LLMs
- Conteúdo em formato pergunta-resposta, mais citável por assistentes de compra

### Arquitetura da solução

Decisão: **stack própria custom** (não vamos usar o Deco Studio) — construiremos nosso próprio
backend/orquestrador de agentes e um dashboard próprio do zero.

- Multi-agente: precisamos de orquestração própria (sem framework da Deco)
- Painel de conexão a ferramentas externas (VTEX, Google Search Console, Claude API) construído por nós
- Controle total da stack, sem lock-in na plataforma do evento

**Stack técnica escolhida:** Node.js/TypeScript no backend (encaixa direto com o SDK da Anthropic e MCP)
+ frontend leve (React ou Vue, sem Vuetify). Decisão tomada 2026-08-01 após avaliar reaproveitar a
stack do projeto interno "Mundial" (Laravel 13 + Vue3/Inertia/Vuetify + PostgreSQL + Redis + Docker) —
descartado porque (a) o repo do Mundial é privado com segredos reais de produção, não dá pra usar como
entregável público, e (b) aquela stack não tem nenhum precedente de orquestração de agentes de IA, que
é o núcleo do hackathon.

**A definir:**
- [ ] Problema específico dentro da frente (ex: descrições incompletas/genéricas, imagens sem alt-text/SEO, atributos faltando, categorização inconsistente)
- [ ] Credenciais de acesso à VTEX (App Key/App Token, conta) — quem consegue gerar?
- [ ] Métrica de impacto (ex: % de SKUs enriquecidos, ganho estimado de CTR/posição no GSC, tempo economizado vs. processo manual)
- [x] Framework específico — Fastify no backend, React no frontend, Drizzle ORM
- [x] Desenho dos agentes — Analyst, Catalog Reader, Content Enrichment, Image Alt-Text, Publisher (ver `server/src/agents/`)
- [x] Armazenamento de credenciais — todas passam pelo painel de Conexões e ficam criptografadas (AES-256-GCM) na tabela `connections`; só a chave mestra e o client OAuth do Google ficam em `.env`
- [x] Acesso à propriedade GA4 de mundialacabamentos.com.br — confirmado, usuário tem acesso a todas as ferramentas Google (GSC, GA4, Merchant Center)
- [ ] Nota: ranking real no Google leva tempo pra mudar — usar GSC principalmente como linha de base do problema, não como prova de resultado dentro dos 9 dias do evento
- [ ] Como medir impacto de GEO (ainda não há um "GSC" padrão de mercado pra isso — considerar checagem manual em ChatGPT/Perplexity antes/depois, ou score de estruturação de conteúdo)

### Estado da implementação (2026-08-01)

Scaffold completo e testado localmente end-to-end:
- `server/` — Fastify + TypeScript + Drizzle, 6 tabelas migradas em Postgres+pgvector, filas BullMQ
  contra Valkey (worker de enrichment e de publish), clients VTEX/GSC/GA4/Claude com retry/backoff,
  criptografia de credenciais, rotas de API (`/api/connections`, `/api/runs`, `/api/proposals`, `/api/products`).
- `web/` — React + Vite com as 4 páginas (Conexões, Runs, RunDetail com revisão humana, Impacto).
- `docker-compose.yml` — Postgres(pgvector) na porta **5433** (5432 já estava ocupada pelo Postgres
  do projeto Mundial nesta máquina) + Valkey na 6379.
- Testado: boot do servidor, boot do worker, criação de conexão via API com criptografia/teste real
  contra a Anthropic (retornou erro esperado com chave falsa), listagem sem vazar segredo.

Pendente antes de rodar contra dados reais: credenciais VTEX, app OAuth do Google Cloud Console
(Client ID/Secret com escopo Search Console + Analytics), chave real da Anthropic.

### Evolução (2026-08-01, segunda rodada)

Validação crítica da lógica de enriquecimento levou a 3 correções/adições:

1. **JSON confiável** — `enrichProductContent` agora usa tool-use forçado da Claude (`tool_choice`)
   em vez de parsear texto livre como JSON; elimina o risco de quebrar o run se o modelo decidir
   escrever prosa antes do JSON.
2. **Score de prioridade normalizado** — o Analyst normaliza os sinais de GSC/GA4 (0-1 pelo máximo
   do lote) antes de somar, em vez de somar valores brutos em escalas diferentes.
3. **Agente Evaluator** (`server/src/agents/evaluator.agent.ts`) — pontua o conteúdo original E o
   proposto na mesma régua (checklist estrutural sem IA + "confiança de comprador" e "perguntas
   respondidas" via 1 chamada Claude), grava em `content_scores`, e serve de guard-rail contra
   alucinação (`unsupportedClaims`). Isso dá uma prova de melhoria **imediata**, sem depender do
   tempo de re-rank do Google — importante pro vídeo de 3 minutos do hackathon.

Painel redesenhado (layout com sidebar, paleta validada via skill `dataviz`, status badges
dot+label, stat tiles, meter de score, e o comparativo antes/depois em formato dumbbell no
RunDetail). Verificado com screenshot real (Playwright) nas 4 páginas, incluindo um preview com
dados de teste (depois removidos) pra validar o comparativo antes/depois. Um bug visual real foi
achado e corrigido nesse processo: o `<select>` da página Impacto não herdava o tema escuro.

### Deploy e CI/CD (2026-08-01, terceira rodada)

Arquitetura de validação e deploy espelhando o projeto "Mundial" (GitHub Actions + Docker Compose +
VPS Hostinger), adaptada de Laravel/PHP para Node/TS + React. Ainda **não é uma arquitetura SaaS**
(single-tenant, uma VPS), mas sem decisão que dificulte evoluir pra isso depois.

- `.github/workflows/ci.yml` — type-check + build do server e do web em PR e push pra `main`.
- `.github/workflows/deploy-production.yml` — builda e publica 2 imagens (server, web) no GHCR,
  envia o bundle pra VPS via SSH, `docker compose pull/up`, roda migrations (só o serviço `app`,
  via `server/docker-entrypoint.sh` com `RUN_MIGRATIONS`), valida health check. **Trigger por
  enquanto é só `workflow_dispatch` (manual)** — só adicionar `push: main` depois que os secrets
  da VPS existirem, pra não falhar sozinho a cada push.
- `server/Dockerfile` + `web/Dockerfile` (nginx servindo o build estático + proxy de `/api/*` pro
  serviço `app`) + `docker-compose.prod.yml` (app, worker, web/nginx, db postgres+pgvector, valkey).
- `.env.production.example` documenta as variáveis esperadas no secret `PRODUCTION_ENV_FILE`.
- **Validado localmente de ponta a ponta**: build das duas imagens Docker, stack completa subindo
  via `docker-compose.prod.yml` (com `pull_policy` sobrescrito pra imagem local), migração rodando
  automaticamente no boot do `app`, worker subindo sem re-migrar, nginx respondendo `/health` e
  fazendo proxy de `/api/health` corretamente. Stack de teste derrubada e limpa depois.
- **Bug real encontrado e corrigido nesse processo**: como os dois `docker-compose` (dev e prod)
  ficam na mesma pasta, sem nome de projeto explícito eles competiam pelo mesmo container do
  Valkey — subir o compose de produção substituiu o Valkey de dev, que foi removido ao derrubar a
  stack de teste. Sem perda de dado real (volume do Postgres de dev é separado e ficou intacto;
  Valkey só guardava fila efêmera), mas corrigido adicionando `name: catalogia-prod` no topo do
  `docker-compose.prod.yml` pra nunca mais colidir com o projeto de dev.

**Combinado com o usuário:** a VPS Hostinger já existe, mas a configuração final (secrets do
GitHub — `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_DEPLOY_PATH`, `GHCR_USERNAME`,
`GHCR_TOKEN`, `PRODUCTION_ENV_FILE` — e o domínio de produção) fica **para depois**, por decisão
explícita do usuário ("podemos configurar na VPS por último?"). Até lá, `deploy-production.yml`
existe mas não roda automaticamente.

### VPS provisionada e domínio configurado (2026-08-02)

Domínio de produção decidido: `app.assessoriadigitalvicosa.com.br` (subdomínio de um domínio já
existente do usuário, DNS gerenciado no Cloudflare). VPS contratada na Hostinger: São Paulo,
Ubuntu 24.04 LTS, IP `46.202.144.198`.

- Registro DNS criado no Cloudflare: `A app → 46.202.144.198`, com proxy (nuvem laranja) ativado.
- **A zona já roda SSL/TLS em modo "Full (strict)"** (por causa de outro serviço no domínio
  principal, não decisão nossa) — isso significa que a Cloudflare só repassa tráfego pra origem
  se ela apresentar um certificado válido; HTTP puro (o que `docker-compose.prod.yml` servia até
  agora) seria rejeitado. Em vez de baixar a segurança da zona pra "Flexible", geramos um
  **Cloudflare Origin Certificate** (15 anos de validade, confiável especificamente pela
  Cloudflare) e adicionamos um segundo `server` block (porta 443) em `web/docker/default.conf`
  usando esse certificado. O cert/key **não fazem parte da imagem Docker** — ficam só no
  filesystem da VPS (`/etc/ssl/cloudflare/{cert,key}.pem`), montados como volume read-only no
  serviço `web` (mesma lógica de por que o `.env` também não é assado na imagem). Porta 443
  adicionada ao `docker-compose.prod.yml`.
- **Pendente**: colar o certificado/chave gerados no Cloudflare nesses dois arquivos na VPS antes
  do primeiro deploy — sem isso o serviço `web` sobe mas o nginx falha ao iniciar (certificado
  ausente). Depois disso: gerar par de chaves SSH pro `VPS_SSH_KEY`, preencher os demais secrets
  do GitHub Actions, e então habilitar o `deploy-production.yml`.

### Primeiro deploy em produção concluído (2026-08-02)

Certificado instalado, os 8 secrets do GitHub Actions preenchidos, `push: main` habilitado no
`deploy-production.yml`. Descoberto nesse processo: o projeto inteiro nunca tinha sido commitado
(só existia um "Initial commit" com um README de 1 linha) — commit real feito (131 arquivos) e
push pro `main`. CI e Deploy Production rodaram automaticamente e concluíram com sucesso; os 5
containers (`app`, `worker`, `web`, `db`, `valkey`) sobem saudáveis; `https://app.
assessoriadigitalvicosa.com.br` responde em HTTPS de ponta a ponta (Cloudflare → origem, ambos
os trechos criptografados). Primeiro usuário admin criado em produção via
`docker compose exec app node dist/scripts/create-admin.js` (banco de produção começa vazio —
senha diferente da usada em dev).

**Segundo deploy (Resend + favicon) falhou por bloqueio de rede temporário** — o passo "Upload
and deploy on VPS" deu `Connection timed out` nas 3 tentativas do retry já existente. Confirmado
direto na VPS que não é bloqueio nosso (ufw inativo, sem regra de iptables bloqueando, fail2ban
nem instalado) — é bloqueio externo, na borda de rede da Hostinger, no IP compartilhado/rotativo
do runner do GitHub Actions (mesmo sintoma documentado no projeto Mundial). Sem correção de
código necessária; resolve sozinho re-rodando o workflow depois do bloqueio expirar.

**Pendências de segurança identificadas, para ajustar depois (não bloqueiam o uso agora):**
- **Senha root da VPS ainda ativa** — o deploy automático já usa só chave SSH, mas a senha root
  (que passou por esta conversa de texto) continua funcionando pra login. Trocar ou desativar
  autenticação por senha no SSH (`PasswordAuthentication no` no sshd_config), deixando só chave.
  **Não verificado de novo desde que foi escrito** — só o usuário, com acesso à VPS, pode
  confirmar se já foi feito.
- ~~**CORS da API permissivo** (`origin: true`)~~ — **corrigido**: `server/src/api/server.ts`
  hoje usa uma allowlist real (`allowedOrigins`), não mais `origin: true`. Nota mantida como
  registro de que já foi resolvido, não como pendência.
- Recadastrar as conexões (VTEX/Shopify, Anthropic/OpenAI/Gemini, Google) pela tela de
  Integrações em produção — o banco novo não herda nada do ambiente local. **Não verificado daqui**
  — só o usuário sabe se já reconectou tudo em produção.

### Gate de qualidade com auto-correção (2026-08-01, quarta rodada)

Validação do fluxo completo de Catalog & Content + SEO/GEO apontou que nada no pipeline garantia
que o conteúdo entregue fosse *de verdade* melhor — só media depois do fato. Correção: o
`Content Enrichment` agora **itera contra o próprio Evaluator antes de submeter pra revisão
humana**, em vez de gerar uma vez e aceitar o resultado:

- Gera uma descrição, pontua na régua do Evaluator (`computeContentScore`, sem persistir ainda).
- Se o score não bater `QUALITY_THRESHOLD` (75) **e** não melhorar pelo menos `MIN_IMPROVEMENT`
  (+20 pontos) sobre o original, regenera — passando de volta pro Claude, como feedback explícito,
  as perguntas de comprador sem resposta e as alegações não sustentadas que o Evaluator encontrou
  (`enrichProductContent(..., feedback)` em `claude.client.ts`).
- Até `MAX_ATTEMPTS` (3) tentativas; fica sempre com a **melhor** pontuada, não a última (uma
  tentativa final pior que a anterior não regride o resultado).
- `content_scores.attempts` registra quantas tentativas foram precisas; o painel (`RunDetail`)
  mostra "Refinado automaticamente em N tentativas até atingir score X" quando N > 1 — vira
  narrativa forte pro vídeo ("o agente não aceita qualquer coisa, ele se corrige sozinho").
- Custo/tempo sobem no pior caso (até ~7 chamadas Claude por produto só na parte de conteúdo,
  entre gerar e avaliar cada tentativa) — aceitável porque o caminho comum (1ª tentativa já boa)
  não muda, e o critério de "Execução Técnica"/"Impacto no Negócio" do julgamento pesa mais que
  economizar chamada de API.

Também ficou registrado, mas **não implementado ainda** (depende de confirmação do usuário se a
loja tem dado real disponível): usar avaliações de clientes que já compraram (VTEX Reviews &
Ratings, se ativo na conta) como fonte de perguntas *reais* pro Evaluator e pro Content
Enrichment, em vez de só perguntas simuladas pela IA.

### Seletor de otimização com custo estimado por campo (2026-08-02)

Antes desta mudança, todo run gerava sempre os 5 campos de conteúdo (descrição, bullets,
specs, FAQ, dados estruturados) + alt-text de imagem, sem opção de escolher. Agora, tanto o botão
"Otimizar"/"Refazer" de uma linha quanto o botão em massa abrem um modal
(`OptimizationFieldSelector.tsx`) antes de criar o run:

- Lista os 6 campos com checkbox + custo estimado em USD/BRL, calculado com o preço real do
  modelo atualmente roteado (`GET /api/runs/field-estimates?productCount=N`,
  `field-cost-estimates.ts`) — não é um valor fixo, reflete o roteamento atual de modelos.
- "descrição" continua sendo sempre gerada internamente pela chamada ao LLM mesmo se
  desmarcada (o loop de qualidade precisa dela pra pontuar), mas só vira proposta na tela se o
  usuário de fato marcar o campo — ver `buildProposalRows` em `content-enrichment.agent.ts`.
- Desmarcar todos os 5 campos de texto pula a chamada de conteúdo inteira pro run (run só de
  alt-text); desmarcar alt-text pula o pipeline de imagem — ambos por produto, sem custo extra.
- Os 3 clients (Claude/OpenAI/Gemini) agora montam o schema/instrução do LLM dinamicamente a
  partir dos campos pedidos (`clients/enrichment-schema.ts`, compartilhado pelos 3), em vez de
  sempre pedir os 5 campos fixos — reduz tokens de saída (e custo real) quando menos campos são
  selecionados, não só a proposta apresentada.
- Estimativa é "por tentativa" (pode haver até 3 tentativas de correção de qualidade por produto,
  custo real pode ser maior) e assume uma média de imagens/produto pro alt-text — é só uma
  prévia, o custo real cobrado continua vindo do log real de tokens em Custos.

### Ideias de evolução futura (não implementadas — anotadas para depois)

- **Migrar os clients de LLM (Claude/OpenAI/Gemini) para LangChain** — avaliado em 2026-08-02.
  Vantagens reais: `.withStructuredOutput()` já lida com as peculiaridades de saída estruturada
  por provedor (pode já contornar o bug de "thinking tokens" do Gemini que caçamos na mão
  nessa data), retry/backoff prontos, composição de pipeline via LCEL, abstração de vector store,
  observabilidade via LangSmith. Custo estimado pra migrar nessa reta final: **2,5 a 3,5 dias**
  (reescrever os 3 clients preservando o rastreamento de custo por token que alimenta o
  Dashboard/RunDetail, reverificar confiabilidade de saída estruturada nos 3 provedores de novo,
  rewiring do orchestrator/agents + reteste ponta-a-ponta). Decisão: **não fazer agora** — a
  arquitetura atual (clients finos, controle total sobre a resposta crua de cada provedor) já
  funciona após o fix do `thinking_level`, e foi exatamente esse acesso cru que permitiu achar a
  causa raiz rápido; troca de framework é aposta em manutenibilidade futura, não requisito pra
  terminar o projeto. Revisitar só se bugs de formatação por provedor continuarem recorrentes.

- **Analytics completo de otimizações** — pedido em 2026-08-03, não implementado ainda. Deve
  incluir: histórico de gastos mês a mês (não só o mês corrente, que já existe no Dashboard),
  quantidade de otimizações por tipo de campo (descrição, FAQ, bullets, specs, dados estruturados,
  alt-text, imagem gerada), e por nível/tier de modelo usado (qualidade/equilibrado/preço — ver
  `model-recommendations.ts`). Dá pra montar em cima do que já existe em `agent_request_logs`
  (tem `provider`/`model`/`costUsd`/`createdAt` por chamada) sem precisar de tabela nova.

- **Analytics agregado combinando Google + otimizações** — pedido em 2026-08-05 ("colocar no
  radar"), não implementado. Diferente do item acima (que é sobre custo/uso de IA): a ideia é uma
  visão histórica cruzando os deltas reais de GSC/GA4 (`impact.agent.ts`) com o histórico de runs
  de otimização — ex. "impressões subiram X% no mês seguinte às otimizações de categoria Y". Hoje
  o `RealImpactPanel` só existe por produto, sob demanda; um agregado exigiria decidir uma janela
  comum entre produtos com `publishedAt` diferentes (ver nota de escopo cortado na seção "Qualidade
  de conteúdo com dados reais + impacto real sem tabela de snapshot" abaixo) — o custo de N
  chamadas ao Google por produto na carga de uma página só valeria a pena com mais produtos já
  maturados do que os 2 que temos até agora.

- **Geração de vídeo curto** — adiado para 2026-08-04 ("vamos fazer amanhã"). Ainda não
  pesquisado; a geração de imagem (ver abaixo) já dá o padrão de client/agent/rota a seguir.
  Especificação confirmada pelo usuário: o vídeo gerado deve ter **entre 15 e 30 segundos** — não
  confundir com a duração do vídeo de demo do hackathon (5 minutos, ver "Entregáveis
  obrigatórios"), são coisas completamente diferentes.

- **Seleção de recorte da foto de referência para guiar a geração da foto de destaque** — pedido
  em 2026-08-05, não implementado. Hoje `image-generation.agent.ts`'s `feature_callout` prompt só
  aceita uma nota de texto livre (`note`) pra dizer qual detalhe destacar; a ideia é deixar o
  usuário desenhar/selecionar uma região (crop) de uma das fotos de referência do produto, e usar
  essa seleção (recorte + coordenadas, ou só o recorte como imagem de referência adicional) como
  guia visual pro Gemini saber exatamente em qual ponto do produto focar, em vez de depender só de
  descrição em texto.

- **Ajustes na tela de Integrações (`web/src/pages/Connections.tsx`)** — pedido em 2026-08-05, não
  implementado:
  - **Melhorar "Roteamento de modelos"** — sem escopo definido ainda, só anotado que precisa
    revisão.
  - **"Limites de gasto mensal por provedor"** — trazer/exibir o saldo restante de cada provedor
    de LLM (Anthropic/OpenAI/Gemini), não só o limite configurado por nós.
  - **Remover "Franquia gratuita por provedor"** — decisão do usuário: não faz sentido manter essa
    seção.
  - **Remover "Moeda de exibição"** — decisão do usuário: o valor convertido fica impreciso por
    depender de cotação (câmbio), não vale a pena manter.
  - **Reordenar os conectores**: mover o conector do Google (Search Console + GA4) pra baixo do
    conector da plataforma de catálogo (VTEX/Shopify) na mesma tela.

- ~~**Descrição em HTML rico de verdade (padrão gsuplementos)**~~ — **implementado em
  2026-08-03/04** como os níveis Bom/Excelente (`DescriptionRichness`), ver seção "Score
  composto, níveis de anúncio e Padrões de Otimização" abaixo — HTML estruturado + imagem
  embutida no nível Excelente, escolhida por visão multimodal a partir das fotos reais do
  produto.

- **Configuração de PDP por Marca/Departamento/Categoria/Subcategoria** — pedido em 2026-08-05,
  não implementado. Confirmado como uma das duas únicas frentes pra depois (a outra é a migração
  pra LangChain, acima) — os demais itens levantados nessa mesma rodada (textos de apoio SEO/GEO)
  foram descartados por ora. Hoje a "Configuração de PDP" (`pdp_templates`) resolve por um único
  nível: categoria/subcategoria (ou o catalogo-wide `'*'`), ver `pdp-templates.repo.ts`. A ideia é
  dar ao editor de layout mais níveis de granularidade além desse — por Marca (ex. um padrão só
  pra DECA) e por Departamento (ex. um padrão só pra "Cozinha", acima de Categoria/Subcategoria).
  Exigiria: decidir a ordem de precedência entre os níveis (provavelmente subcategoria > categoria
  > departamento > marca > `'*'`, do mais específico pro mais genérico) e estender
  `resolvePdpTemplate`/`getPdpTemplates` pra considerar múltiplas chaves em vez de só `category`.

- **Palavras recomendadas/proibidas e instruções por campo e por padrão de foto, por categoria** —
  pedido em 2026-08-05, não implementado. Duas peças complementares:
  1. **Listas de palavras por categoria**: cadastrar, por categoria (com fallback pro
     catálogo-wide `'*'`), duas listas de palavras/termos — uma **recomendada** (terminologia que a
     IA deve preferir — vocabulário da marca/categoria) e outra **proibida** (termos a evitar — ex.
     superlativos sem sustentação, concorrentes, termos regulatórios/sensíveis) — aplicadas à
     geração de descrição/SEO/FAQ como um todo.
  2. **Instrução própria por campo de conteúdo e por padrão de foto**: hoje cada campo de conteúdo
     (`description`, `benefit_bullets`, `technical_specs`, `faq`, `structured_data`, `seo_title`,
     `meta_description`, `keywords`, `tags`, `cta`, `attributes_patch` — `EnrichmentField` em
     `llm-types.ts`) só tem um fragmento de prompt fixo no código
     (`FIELD_SPECS[field].promptFragment`, `enrichment-schema.ts`) — não existe onde o usuário digite
     uma instrução própria por campo (ex: "em `benefit_bullets`, sempre citar garantia primeiro").
     Do lado de imagem já existe um campo livre `note` por chamada (`generateProductImage`,
     `image-generation.agent.ts`) pros 4 padrões (`principal`/`lifestyle`/`dimensional`/
     `feature_callout`), mas é digitado a cada geração, não persistido por categoria/padrão. A ideia
     é persistir uma instrução de texto livre por (categoria, campo-ou-padrão-de-foto), reaplicada
     em todo run daquela categoria sem precisar redigitar.

  As duas peças encaixariam na mesma tabela nova, na mesma tela ("Configuração de PDP", mesmo
  seletor de categoria unificado) e no mesmo padrão de resolução específica > `'*'` já usado por
  `category_content_profile`/`category_score_thresholds`/`pdp_templates`. Exigiria: nova
  coluna/tabela chaveada por (plataforma, categoria, campo-ou-padrão-de-foto), um suffix novo em
  `enrichment-schema.ts` que injete a instrução do campo específico (os suffixes existentes —
  `buildContentProfileSuffix`/`buildTopSearchQueriesSuffix`/etc. — são todos globais, não por
  campo), e usar a instrução persistida como default do `note` na tela de geração de imagem. Vale
  considerar também um guard-rail no Evaluator (`evaluator.agent.ts`) que verifique se algum termo
  proibido escapou pro texto final, em vez de confiar só na instrução do prompt.

### Geração de imagem por IA (implementado em 2026-08-03, com uma limitação de conta)

Feature nova: gera foto "ambientada" (produto em cenário de uso real) ou de "destaque" (close-up
em um detalhe), a partir das fotos JÁ existentes do produto (nunca do zero) — usa o Gemini
(`gemini-2.5-flash-image`, via `@google/genai`, já dependência do projeto) porque é o único dos 3
provedores que gera imagem de verdade (Claude só entende imagem, não gera; OpenAI teria que ser
integrado à parte). Nova tabela `generated_images`, agente `image-generation.agent.ts`, rotas
`GET/POST /api/products/:id/generated-images`, botões em RunDetail.

**Dois bugs de parâmetro da API corrigidos ao vivo** (testados direto contra a API real, não
documentação): `response_format.delivery` não pode ser enviado (nem "inline" nem "uri" — dá 400
"Image delivery mode is not supported", tem que omitir o campo inteiro); `thinking_level` pra
modelo de imagem só aceita "low"/"high", nunca "minimal" (que é o valor usado nas chamadas de
texto no mesmo client, funcionando normalmente ali).

**Limitação atual, não é bug**: depois de corrigido o request, a API retornou 429 com `limit: 0`
pro modelo de imagem no tier gratuito — ou seja, geração de imagem simplesmente não está
disponível na cota grátis do Gemini, precisa de billing ativado no projeto Google AI Studio/Cloud
pra essa chamada específica funcionar (as chamadas de texto continuam funcionando no grátis
normalmente). Não testado ponta-a-ponta com uma imagem real até ativar billing.

**Integrado ao seletor de otimização (2026-08-03)**: até aqui a geração de imagem só existia como
botão avulso por produto em RunDetail — agora "Foto ambientada"/"Foto de destaque" também aparecem
como checkboxes opcionais (desmarcados por padrão, custo por imagem) no modal "O que otimizar?",
rodando junto com o resto do run via `imageKinds` em `StartEnrichmentRunParams`. Exige conexão
Gemini configurada quando marcado; falha por produto (sem imagem de referência) não derruba o run
inteiro. Custo por imagem entra no agregado `totalCostUsd` do run normalmente.

**Filtro de categoria/coleção corrigido para Shopify (2026-08-03)**: o filtro "categoria" da tela de
Produtos usava `productType`, que não é o mesmo conceito mostrado na coluna "Coleção" da listagem.
Trocado para usar Collections de verdade (`collections` root query + filtro `collection_id:<id>` na
busca de produtos, verificado ao vivo contra uma loja real). VTEX continua com filtro por árvore de
categorias, sem mudança.

**Bug real encontrado em produção no primeiro teste (2026-08-03): a chave Gemini de produção NÃO
está no plano pago pra geração de imagem** — investigado direto no banco (`agent_request_logs` do
run que travou): os erros são `429 ... limit: 0, model: gemini-2.5-flash-preview-image` (geração de
imagem) e `429 ... limit: 5, model: gemini-3.6-flash` (texto), ambas assinaturas clássicas de
free-tier — isso contradiz o que foi confirmado antes ("na vps é um plano pro"). Precisa checar se
a chave usada em produção realmente pertence ao projeto Google Cloud com billing ativado, ou se é
uma chave diferente/de outro projeto. **Adiado pra amanhã (2026-08-04) por pedido do usuário.**

Enquanto isso, corrigido o efeito colateral real: as chamadas Gemini (`gemini.client.ts`) nunca
tinham retry/backoff (diferente de VTEX/Shopify, que já usam `requestWithRetry` em `http.ts`) — uma
única resposta 429 falhava a chamada na hora e pra sempre. Como o run dispara as chamadas de todos
os produtos em paralelo sem limite de concorrência, um burst de poucos produtos já estourava o
limite de 5 RPM do free-tier e derrubava várias chamadas de uma vez, dando a impressão de "uma
falha trava as demais". Agora `loggedCall`/`generateProductImage` tentam de novo com backoff
exponencial (até 3 tentativas, respeitando o "retry in Xs" do próprio erro do Google quando
presente, limitado a 20s de espera) — exceto quando o erro é `limit: 0` (aí é permanente, tentar de
novo não adianta, falha rápido). Também adicionado `console.error` em toda tentativa que falha, pra
aparecer direto em `docker logs`, sem precisar consultar o banco. Não corrigido ainda: a falta de um
limite de concorrência entre produtos do mesmo run (todos disparam ao mesmo tempo) — ideia pra
amanhã, se o problema persistir mesmo com billing ativado.

**Correção sobre a correção (mesmo dia, direto em produção)**: o primeiro deploy do retry não
funcionou — os logs novos apareciam (`console.error` ok) mas nenhuma tentativa 2/3 ou 3/3 rodava
mesmo em erros claramente "retryable" (`limit: 5`, não `limit: 0`). Causa: o check usava
`err instanceof ApiError` (classe importada de `@google/genai`), e por algum motivo de
ESM/CJS/module-resolution isso deu `false` em produção mesmo pro erro certo — pulando o retry
inteiro silenciosamente. Trocado pra duck-typing (`err.status === 429`, com fallback de regex no
prefixo da mensagem tipo "429 ..."), que não depende de identidade de classe. Confirmado só depois
de olhar `docker logs -t` com timestamp e comparar contra `finished_at` do run no banco — o run
terminava exatos ~10ms depois do log de falha, ou seja, sem esperar o backoff.

### Score composto, níveis de anúncio e Padrões de Otimização (2026-08-03/04, quinta rodada)

Expansão grande de escopo, pedida pelo usuário pra sair de "gerador de descrição" pra "motor de
otimização de catálogo full-funnel", com um olho no critério de Impacto no Negócio do julgamento.
Decisão explícita de escopo pra caber no prazo: **sem busca ao vivo de SERP/IA** (a ideia original
de padrões baseados nos top resultados orgânicos do Google/recomendação de IA foi descartada por
risco de prazo) e **sem instrumentar a loja real** com eventos de engajamento customizados (scroll,
frete, newsletter) — só o que GA4/GSC já expõem.

- **Score composto de 8 sub-scores** (`server/src/agents/evaluator.agent.ts`): além de
  `buyerConfidence`/GEO já existentes, `evaluateContent` (idêntico nos 3 clients Claude/OpenAI/
  Gemini) agora também julga `seoScore`, `conversionScore`, `dataConsistencyScore` e
  `catalogIssues`; `structureScore` (HTML real, não só "tem >200 caracteres") e `readabilityScore`
  são calculados sem chamada de IA (heurística de tamanho de frase/palavras longas), mantendo
  custo controlado. `overallScore` virou média ponderada dos 8 sub-scores percentuais em vez da
  média simples de 3. `GEO_QUESTIONS` expandiu de 5 para 11 perguntas (objeção/garantia/
  comparação/diferencial/entrega inclusos).
- **3 níveis de anúncio — Médio/Bom/Excelente** (`server/src/clients/llm-types.ts`'s
  `DescriptionRichness`): todos os 11 campos de conteúdo são gerados nos 3 níveis (o custo de
  texto é baixo); o que muda é só a `description`: Médio = texto corrido (comportamento antigo),
  Bom = HTML estruturado (títulos/seções/tabela de specs), Excelente = igual ao Bom **+ uma foto
  real já existente do produto embutida inline**, escolhida por uma chamada multimodal (visão de
  verdade, não heurística por nome de arquivo) que identifica o ponto de destaque do texto/
  atributos e escolhe qual foto ilustra melhor — nunca gera imagem nova nessa parte. Geração de
  imagem por IA (lifestyle/feature_callout) continua um opt-in independente, nunca padrão em
  nenhum nível. Seletor "O que otimizar?" (`OptimizationFieldSelector.tsx`) ganhou os 3 botões de
  nível com custo previsto por pacote, grupos (Conteúdo/Catálogo/SEO & GEO/Conversão) e um
  seletor de "Tom de comunicação" (premium/técnico/casual).
- **6 campos novos**: `seo_title`, `meta_description`, `keywords`, `tags`, `cta`,
  `attributes_patch`. Publicação real onde a plataforma tem campo nativo: `seo_title`/
  `meta_description` via novo `updateProductSeo` (VTEX: PUT Title/MetaTagDescription; Shopify:
  `productUpdate` com `seo{title,description}`); `tags` só no Shopify (native field, VTEX fica
  em-app); `cta` funde na descrição como HTML igual ao FAQ (mesmo mecanismo, extraído em
  `renderCtaBlock` — renomeado depois, na rodada de Configuração de PDP). `keywords`/
  `attributes_patch` seguem o precedente de `structured_data`:
  em-app apenas, sem escrita na plataforma — evita o escopo bem mais arriscado de escrever
  atributos/categoria em duas plataformas diferentes. Slug/URL amigável ficou **fora do escopo**
  (mudar URL ao vivo é destrutivo pra SEO se publicado errado).
- **Padrões de Otimização por Categoria** (Excelente/Bom/Médio): nova tabela
  `category_score_thresholds` (2 limites editáveis por categoria + linha `'*'` default),
  repo/rotas (`optimization-thresholds.repo.ts`/`.routes.ts`), tela nova em Connections.tsx
  espelhando o card visual do "Roteamento de Modelos", e badge de nível no RunDetail calculado
  no client a partir do `overallScore` + categoria do produto. Segmento de teste: categorias
  reais de "acabamentos para construção" (mundialacabamentos).
- **Banner "Impacto Estimado"**: nova agregação (`impact-summary.repo.ts`) com deltas antes/
  depois (completude do catálogo, SEO, GEO, conversão, consistência) e tempo economizado
  estimado (constante de 25min manuais/anúncio vs. duração real do run) — por run (`RunDetail`)
  e pra conta toda (`Impact.tsx`), usando o `StatTile`/`.stat-row` já existentes em vez de um
  componente de gráfico novo.
- **Integridade do produto na geração de imagem por IA**: reforço explícito no prompt (proibido
  alterar forma/cor/material/rótulo) + um **gate de verificação pós-geração** novo
  (`GeminiClient.verifyImageIntegrity`) — segunda chamada multimodal independente comparando a
  imagem gerada com a foto de referência; reprovada, tenta de novo (até 2x); esgotado, persiste
  mesmo assim mas marcada `integrityVerified: false` (nunca esconde, mesmo espírito de
  `unsupportedClaims` no texto) e aparece como aviso no RunDetail.
- **Nova aba "Arquitetura"** no menu (acima de Integrações, `web/src/pages/Architecture.tsx`):
  diagrama Mermaid renderizado no cliente (lib `mermaid` adicionada, import dinâmico — só carrega
  pra quem abre a aba) a partir de uma única fonte viva (`lib/architecture-diagram.ts`), pra
  atualizar conforme o pipeline evolui em vez de manter um print estático. Mesmo diagrama também
  publicado como Artifact standalone pro vídeo/pitch, junto com um mockup de PDP nível Excelente
  (exemplo de porcelanato, com etiqueta indicando qual campo gera cada bloco).
- Migração `0017_pretty_kulan_gath.sql` aplicada (colunas novas em `content_scores`/
  `generated_images`, tabela `category_score_thresholds`, 6 valores novos em `proposal_field`).
  Build e type-check de `server` e `web` verificados limpos ao final.

### Publicação real ampliada + fix crítico no PUT da VTEX (2026-08-04, sexta rodada)

Revisão do que "publicar de verdade" significa por campo, motivada por prints reais da conta
Shopify de teste (categoria "Flooring & Carpet" já tem Category metafields como Color/Material, e
Product metafields customizados como `pieces_per_box`/`yield_per_box`/`format` já cadastrados
pela própria mundialacabamentos) e por dois anúncios reais da VTEX (confirmando que
"Especificações"/"Características" — Marca, Material, Acabamento, Bitola, Dimensões etc. — é
exatamente o que `extractVtexSpecifications` já lê).

- **Bullets e Especificações técnicas agora mesclam na descrição** (mesmo mecanismo do FAQ/CTA,
  `publisher.agent.ts`) — decisão validada pelo próprio conteúdo já publicado da loja (a
  descrição real de um produto VTEX já lista specs como bullets dentro do texto).
- **Dados estruturados e Keywords → Shopify Metafields** (namespace `catalogia` fixo, tipo
  `json`) — Shopify apenas; sem equivalente direto na VTEX.
- **Normalização de atributos (`attributes_patch`) → Shopify Metafields reais**: antes de
  escrever, `ShopifyClient.updateProductMetafields` tenta casar a chave com uma definição de
  metafield **já cadastrada** (por nome/chave, normalização + substring) pra "usar a mesma
  terminologia" que a loja já usa; se não achar nada parecido, **cria uma nova definição**
  (`metafieldDefinitionCreate`) em vez de inventar um campo solto — nunca toca nos metafields de
  categoria padrão (Color/Material etc., tipicamente `metaobject_reference`, fora do escopo por
  risco de precisar resolver GID de taxonomia). `getKnownAttributeFields` é consultado **antes**
  da geração (uma vez por run, não por produto) e vira contexto no prompt dos 3 clients de LLM
  (`buildKnownAttributeFieldsSuffix`), pra o modelo preferir as chaves reais em vez de rótulos
  livres.
- **Fotos geradas por IA agora publicam de verdade**: nova rota pública (sem auth, de propósito —
  VTEX/Shopify buscam a URL diretamente) `GET /api/generated-images/:id/raw` servindo os bytes já
  salvos no banco, `CatalogClient.addProductImage` (VTEX: `POST .../stockkeepingunit/{sku}/file`
  com `Url`; Shopify: `productCreateMedia` com `originalSource`), e botão "Publicar na loja" por
  imagem no RunDetail (`generated_images.publishedAt` novo, migração `0018`). Precisa de
  `APP_BASE_URL` configurado (a plataforma busca a imagem da nossa própria API, não do navegador
  do usuário).
- **Bug crítico corrigido antes de qualquer teste real na VTEX**: `PUT /pvt/product/{id}` da VTEX
  **não faz merge parcial** — é um replace completo, então mandar só `{Description: "..."}`
  (como o código fazia até aqui) arriscava zerar Title/LinkId/MetaTagDescription e outros campos
  não incluídos no corpo. Corrigido com um padrão ler→mesclar→escrever
  (`VtexClient.updateProductFields`): busca o produto completo primeiro, mescla só o campo sendo
  alterado, manda o objeto inteiro de volta. Achado a tempo — antes de existir token real de
  produção pra testar contra.
- **Link "Ver na loja" do Shopify corrigido**: a loja de teste ainda não está publicada num
  domínio público (URL de preview `*.shopifypreview.com`, não a storefront real) — trocado pra
  sempre apontar pro produto no **Admin do Shopify** (`/admin/products/{id}`), que funciona
  independente do status de publicação, em vez de adivinhar uma URL de storefront que pode não
  existir ainda.
- **Combinado para amanhã (2026-08-05)**: token real da VTEX chega — ler a API contra a conta de
  produção com cuidado redobrado (é loja real, não a Shopify de teste) antes de qualquer
  publicação em lote. Escrita em "Características" (Specification API da VTEX) fica **para depois
  da validação com o token real** — decisão explícita de não implementar às cegas contra uma API
  mais complexa (campos dependem de tipo: texto livre vs. Radio/Checkbox com valores
  pré-cadastrados) numa loja em produção.

### Configuração de PDP (template determinístico) + Documentação (2026-08-04/05, sexta rodada)

Mudança de arquitetura pedida pelo usuário: "a IA deve ser assertiva e atuar só em partes já
mapeadas da PDP, sem precisar adivinhar onde introduz conteúdo". Investigação mostrou que o
"adivinhar" só existia num lugar — a `description` em si, quando `descriptionRichness` pedia pra
IA escrever `<h2>`/`<table>` livremente; bullets/specs/FAQ/CTA sempre foram dado estruturado
(array/objeto), só viravam HTML na hora de publicar.

- **A IA nunca mais escreve HTML** — `buildDescriptionRichnessSuffix` (`enrichment-schema.ts`)
  não pede mais estrutura; `description` é sempre texto corrido em qualquer nível. Pro nível
  Excelente, a IA ainda identifica o destaque e escolhe a foto (`featuredImageUrl`/
  `imageCaption`), mas não decide mais onde a imagem entra — isso também virou responsabilidade
  do template.
- **Nova tabela `pdp_templates`** chaveada por **(plataforma, categoria, nível)** — `category =
  '*'` é o padrão pra todo o catálogo hoje, mas o modelo já nasce pronto pra granularidade por
  categoria (pedido explícito do usuário: "deixar a possibilidade"). Cada linha guarda uma lista
  ordenada de blocos (`description`, `benefit_bullets`, `technical_specs`, `featured_image`,
  `faq`, `cta`).
- **`renderPdpHtml` em `publisher.agent.ts`** é agora o único lugar que gera HTML de descrição —
  percorre os blocos do template na ordem configurada, renderizando cada um de forma
  consciente do nível (Médio = texto corrido puro, sem `<ul>`/`<table>`; Bom/Excelente = HTML
  semântico real). A imagem de destaque passou a ser uma **proposta própria**
  (`proposal_field = 'featured_image'`, migração `0020`) revisável como qualquer outra, em vez
  de vir pré-embutida na descrição no momento da geração.
- **Tela "Configuração de PDP"** (novo item de menu, gated por permissão de conexões): 3 cards
  (Médio/Bom/Excelente) com os blocos ativos, reordenáveis (↑/↓) e removíveis/adicionáveis —
  edita a plataforma ativa no momento.
- **Tela "Documentação"** (novo item de menu, aberto pra qualquer usuário): índice dos materiais
  gerados durante o desenvolvimento (diagrama de arquitetura, referência de APIs, exemplo de PDP
  nível Excelente), cada um com link pra fonte viva no repo e pro Artifact publicado.
- **`docs/README.md` e `docs/exemplos/pdp-nivel-excelente.html` criados no repositório** — até
  aqui o exemplo de PDP só existia como link de Artifact externo, sem cópia permanente versionada
  junto do código.
- Diagrama de arquitetura (`architecture-diagram.ts`) atualizado com o nó de Configuração de PDP
  alimentando o Publisher — prática combinada com o usuário: toda mudança de peso a partir de
  agora atualiza a documentação viva (diagrama/referência de APIs) e este arquivo, não só o código.

### Auditoria pós-implementação + preview de PDP (2026-08-05, sexta rodada continuada)

Rodada de auditoria pedida pelo usuário ("analisar inconsistências e falhas") com 3 buscas em
paralelo (código morto, corretude das features menos testadas, documentação vs. código real).
Achados corrigidos na hora:

- **Bug real em `resolvePdpTemplate`**: quando a categoria do produto é nula/vazia (comum —
  Shopify sem `productType`, VTEX sem categoria resolvida), a função pulava a consulta ao banco
  inteira e nunca considerava o template `'*'` configurado pelo usuário, caindo direto no padrão
  de fábrica. Corrigido pra sempre consultar e só pular o match "específico" quando não há
  categoria.
- **Falso positivo no casamento de metafield do Shopify**: `findMatchingDefinition` só
  garantia tamanho mínimo do lado do rótulo novo, não do nome/chave já existente — um campo
  curto como "Cor" podia casar por substring dentro de qualquer palavra que contivesse essas
  letras (ex: "Decoração"). Corrigido exigindo tamanho mínimo dos dois lados da comparação.
- **Gate de integridade de imagem não distinguia erro de rede de reprovação real** — uma falha
  de conexão na chamada de verificação descartava a imagem já gerada (e já cobrada) inteira, em
  vez de registrar "não verificado" e seguir. Agora envolto em try/catch próprio.
- **Publicar imagem não verificada só tinha aviso visual, não bloqueio de verdade** — um humano
  podia clicar "Publicar na loja" mesmo com o aviso de integridade não confirmada. Agora a rota
  `POST /api/products/:id/generated-images/:imageId/publish` recusa (400) se
  `integrityVerified` for falso, e o botão fica desabilitado no RunDetail.
- **Documentação com números errados**: "score composto de 11 métricas" corrigido pra "8
  sub-scores" em `architecture-diagram.ts`, `pipeline-flow.ts`, `docs/README.md` e
  `HACKATHON.md` (o 11 vinha de `GEO_QUESTIONS.length`, sem relação com a contagem de
  sub-scores). Referência a `renderCtaHtml` (renomeada pra `renderCtaBlock`) corrigida.
  `api-reference.ts` ganhou as entradas que faltavam (embeddings da OpenAI pro RAG de produtos
  quase-duplicados; envio de e-mail via Resend).
- Cruft identificado mas **deixado pra depois por decisão do usuário**: as colunas
  `content_scores.checklistScore`/`geoAnswerableCount`/`geoTotalQuestions` ficaram só-escrita
  (nunca lidas pelo frontend) desde que o score composto de 8 sub-scores as substituiu — baixo
  impacto, não vale a migração extra agora.
- **Item "Arquitetura" removido do menu** (duplicava a página "Documentação", que já linka pra
  ela) — a rota continua existindo, só não é mais um item de topo.
- **Configuração de PDP ganhou abas por nível + preview visual real**: em vez de 3 cards
  empilhados, agora é uma aba por nível (Médio/Bom/Excelente) com um preview ao lado — renderizado
  no servidor pela mesma função (`renderPdpHtml`, agora exportada de `publisher.agent.ts`) que
  publica de verdade, com dado de exemplo genérico (nunca uma foto de estoque real) — pra nunca
  divergir do que a publicação realmente produz. Nova rota `POST /api/pdp-templates/preview`.

### Reorganização da documentação no app + preview de PDP configurável (2026-08-05)

Ajustes de UX pedidos pelo usuário depois de revisar a navegação:

- **"Arquitetura" saiu do menu principal** — ficava duplicada com "Documentação", que já linka
  pra ela.
- **Referência de APIs virou página própria** (`/api-reference`, `web/src/pages/ApiReference.tsx`),
  separada de "Arquitetura" (que ficou só com diagrama + fluxo + riscos) — a página única estava
  ficando longa/confusa. Ganhou uma aba por sistema (VTEX, Shopify, GSC, GA4, Claude, OpenAI,
  Gemini, Resend) em vez de tudo empilhado.
- **Documentação, Arquitetura e Referência de APIs agora exigem permissão de Integrações** — antes
  estavam abertas pra qualquer usuário logado.
- **Links de Artifact removidos da Documentação e do `docs/README.md`** — a aba Arquitetura no
  app já é mais completa (tem Fluxo atual/Riscos que os Artifacts não têm) e manter as duas
  versões em sincronia era a mesma duplicação que a auditoria de código morto apontou. Os
  Artifacts publicados continuam existindo (não foram deletados), só não são mais referenciados
  como parte da documentação oficial.
- **Configuração de PDP ganhou preview visual configurável**: abas por nível + um preview ao
  lado renderizado pela mesma função (`renderPdpHtml`) que publica de verdade, com conteúdo de
  exemplo genérico — inspirado no mockup do porcelanato, mas dinâmico em vez de estático. Nova
  rota `POST /api/pdp-templates/preview`.

### Revisão de lógica de negócio (2026-08-05, continuação)

Pedido do usuário: "analise toda a lógica que estamos desenvolvendo" — indo além de bugs de
código pra questionar se as regras de negócio fazem sentido. 3 achados corrigidos:

- **Conflito de nomenclatura resolvido**: a classificação por score (badge no RunDetail, limites
  em Connections.tsx) deixou de se chamar Excelente/Bom/Médio e passou a ser **Ouro/Prata/Bronze**
  (`ScoreTier` em `optimization-thresholds.repo.ts` e `web/src/api/client.ts`). Motivo: esse
  vocabulário já era usado pro **nível de geração** (`DescriptionRichness`, escolhido antes de
  rodar, controla estrutura HTML) — e os dois podiam discordar (um produto gerado no nível Médio,
  texto corrido, podia classificar como "Excelente" pelo score se SEO/conversão/completude
  fossem altos por outros motivos). Zero sobreposição de palavras agora entre os dois conceitos.
- **Gate de qualidade corrigido pra não ser matematicamente impossível**: a regra exigia `score ≥
  75 E score - original ≥ 20` — para qualquer produto cujo conteúdo original já pontuasse acima
  de 80, a exigência de melhoria passava de 100 (inatingível), fazendo o loop **sempre** esgotar
  as 3 tentativas (triplicando o custo de IA) mesmo quando a 1ª tentativa já era ótima. Corrigido
  com uma válvula de escape: um score final ≥ 95 (`NEAR_PERFECT_SCORE`) passa mesmo sem bater a
  melhoria completa de +20 (`content-enrichment.agent.ts`).
- **Caminho de reaproveitamento (RAG) continua pulando o gate de qualidade — decisão consciente,
  agora documentada em código**: o ganho de custo do RAG depende de não repetir tentativas, e o
  produto "doador" já passou por aprovação humana antes, então parte de uma base mais forte que
  uma geração do zero.
- Achado, mas deixado como limitação documentada (não corrigido): "Completude do catálogo" usa
  como denominador a união de chaves entre atributos originais e o que a própria IA propôs
  (`attributesPatch`) — não é um alvo fixo por categoria, então o mesmo agente medido também
  define o que está sendo medido. Sem correção fácil sem um catálogo de atributos esperados por
  categoria (feature maior, fora do escopo do prazo restante).

### Qualidade de conteúdo com dados reais + impacto real sem tabela de snapshot (2026-08-05, sétima rodada)

Pedido do usuário: 3 melhorias de qualidade de conteúdo discutidas em rodada anterior
("Pode implementar tudo"), seguidas de uma repensada completa de como medir impacto de negócio.

**As 3 melhorias de conteúdo:**
- **SEO ancorado em buscas reais do Search Console**: `GscClient.queryTopQueriesByPage`
  (dimensions `["page","query"]`) busca, uma vez por run, as top buscas reais por página; o
  Analyst resolve por produto via `pathnameOf` (agora exportado) e passa `topSearchQueries` pro
  `enrichProductContent` dos 3 clients — o prompt passa a priorizar termos que compradores de
  fato digitam em `seoTitle`/`keywords`/`description`, em vez da IA inventar palavras-chave
  plausíveis (`enrichment-schema.ts`'s `buildTopSearchQueriesSuffix`).
- **Evaluator em provedor diferente do Content Enrichment**: `DEFAULT_ROUTING` em
  `model-routing.repo.ts` passou de tudo-Anthropic para Content Enrichment=Anthropic,
  Evaluator=OpenAI — julgar um rascunho com o mesmo modelo que o escreveu é circular (tende a
  aprovar seu próprio estilo). **Atenção**: uma instância já em produção tem uma linha salva no
  banco que sobrepõe esse default do código — precisa ajustar manualmente em Integrações →
  Roteamento de Modelos.
- **Completude do catálogo com alvo fixo por categoria**: era a limitação documentada na rodada
  anterior (denominador = união entre atributos originais e o que a própria IA propunha, o mesmo
  agente medido definia o que estava sendo medido). `catalog-attributes.repo.ts`'s
  `getExpectedAttributeKeys(category)` calcula a frequência real de cada atributo entre produtos
  **já sincronizados** dessa categoria (≥50% de presença, mínimo 3 produtos) e usa isso como alvo
  fixo em `evaluator.agent.ts`, passado desde `content-enrichment.agent.ts`.

**Impacto real repensado — removida a tabela de snapshot:**

Discussão com o usuário sobre os números de impacto mostrarem `+0pp` pra quase tudo: o banner
"Impacto Estimado" é 100% auto-avaliado pela mesma IA (original vs. proposto), com média de só 2
produtos e arredondamento pra inteiro — ganho real pequeno arredonda pra zero. Renomeado pra
**"Confiança de conteúdo (estimada por IA)"** pra não se passar por medição real
(`ImpactSummaryBanner.tsx`).

Pra medir impacto de verdade, a ideia inicial era popular `product_metrics` com um job
recorrente — descartada pelo próprio usuário ("podemos remover o snapshot e alterar por consulta
padrão"): GSC guarda ~16 meses de histórico diário e GA4 cobre qualquer range dentro da retenção
da propriedade, então **não há necessidade de guardar cópia própria** — só consultar ao vivo com
o range certo. Implementado:
- **Tabela `product_metrics` removida** (migração `0021_legal_marvex.sql`, `DROP TABLE ...
  CASCADE` + `DROP TYPE metric_source`) — o Analyst continua consultando GSC/GA4 ao vivo pra
  priorizar, só parou de persistir o resultado.
- **`real-impact.repo.ts`**: `getEarliestPublishedAtByProduct` — o `publishedAt` mais antigo entre
  as proposals aprovadas de um produto é o pivô real "antes vs. depois" (não mais "quando o
  Analyst rodou por acaso").
- **`impact.agent.ts`**: `getProductRealImpact` — compara uma janela de 28 dias antes do publish
  com uma janela de 28 dias começando 14 dias depois (`MATURATION_DAYS`, tempo que o Google
  precisa pra refletir a mudança); antes disso retorna `status: "maturing"` com contagem
  regressiva em vez de um número de ruído. 4 chamadas ao Google por produto, só quando o usuário
  abre a comparação — nada em lote, nada agendado.
- **Página Impacto**: as duas tabelas de histórico (GSC/GA4) trocadas por `RealImpactPanel.tsx`,
  que trata os 4 estados (`no_url`/`not_published`/`maturing`/`ready`) explicitamente em vez de só
  "sem dado".
- Badge "Impacto" na lista de produtos (`catalogRoutes`'s `impactReadiness`) trocou de "contagem
  de snapshots" pra "dias desde a primeira publicação vs. `MATURATION_DAYS`" — mesma cor
  (verde/amarelo/vermelho), significado mais correto.
- **Escopo cortado deliberadamente**: o banner agregado (toda a conta) ainda é só o de IA — um
  agregado de Impacto real cruzando todos os produtos publicados e maturados fica como ideia
  futura, não implementado agora (custo de N chamadas ao Google por produto na carga da página
  de Impacto, sem paralelo ainda com dados suficientes pra valer o esforço com só 2 produtos
  otimizados até agora).

**Reorganização de UI**: "Padrões de Otimização por Categoria" (limites Ouro/Prata/Bronze) saiu
de Connections.tsx e passou a viver dentro de "Configuração de PDP" — mesma tela onde a categoria
e o nível já são configurados, evitando espalhar configuração de otimização por duas páginas.
Removida a entrada "Exemplo de PDP — nível Excelente" (mockup estático) da Documentação — hoje a
própria "Configuração de PDP" tem preview ao vivo renderizado pela função real de publicação, o
mockup ficou redundante (`docs/README.md` atualizado no mesmo sentido).

### Concorrência limitada + primeira suíte de testes automatizados (2026-08-05, oitava rodada)

Pedido explícito do usuário, priorizando 2 dos riscos conhecidos listados na aba Arquitetura:
"Sem limite de concorrência entre produtos num run" e "Zero teste automatizado". Os dois eram os
únicos riscos da lista que não dependiam de acesso à conta real da VTEX pra resolver — dava pra
atacar agora, sem esperar o token chegar.

**Limite de concorrência**: `lib/concurrency.ts`'s `mapWithConcurrency` — versão com limite do
`Promise.allSettled(...map(...))` que o orquestrador usava antes, que disparava as chamadas de IA
de TODOS os produtos do run ao mesmo tempo (um run de "otimização total" com topN=50 significava
50+ chamadas simultâneas por tipo de task). Agora cada task (Content Enrichment, Image Alt-Text,
Geração de Imagem) roda no máximo `ENRICHMENT_CONCURRENCY` produtos por vez (padrão 5, configurável
via `.env`) — mesma assinatura de retorno do `Promise.allSettled` (array de
`PromiseSettledResult`), então o resto do orquestrador não precisou mudar.

**Primeira suíte de testes (vitest, 35 testes, 5 arquivos, roda no CI a cada push/PR)**:
- `lib/concurrency.test.ts` — respeita o limite, preserva ordem dos resultados, um item rejeitado
  não trava os outros.
- `agents/evaluator.test.ts` — `structureScore`, `readabilityScore`,
  `computeAttributeCompleteness` (incluindo o caso com baseline fixo por categoria vs. o fallback
  de união de chaves), e `computeContentScore` com um `LlmClient` fake (sem chamada de rede real).
  Achado ao escrever o teste (não é bug, mas merece registro): quando não há texto E nenhum
  atributo/patch/baseline (`attributesExpected = 0`), `percentOrFull(0,0)` retorna 100 ("nada
  esperado = 100% completo"), então o fallback de "sem draft pra avaliar" pontua 13, não 0 —
  comportamento documentado no teste em vez de escondido.
- `agents/publisher.test.ts` — `renderPdpHtml`/`escapeHtml`: escapa HTML malicioso, respeita
  ordem dos blocos, renderiza texto corrido no nível Médio vs. HTML semântico real no
  Bom/Excelente, nunca renderiza um bloco sem dado (mesmo se listado no template).
- `agents/impact.test.ts` — `getProductRealImpact` com `GscClient`/`Ga4Client` fake e
  `real-impact.repo.ts` mockado (`vi.mock`): as 4 transições de estado
  (`no_url`/`not_published`/`maturing`/`ready`), casamento por pathname ignorando produtos
  errados, e delta de 0% tratado como +100% (não divide por zero).
- `api/client.test.ts` (web) — `classifyScore`: limite inclusivo na borda exata, prioridade de
  override por categoria sobre o `'*'` padrão, fallback pra bronze sem nenhum threshold
  configurado.

**Setup**: `vitest` como devDependency nos dois projetos (`server`/`web`), scripts `test`/
`test:watch`, `vitest.config.ts` no server injetando valores fake pras env vars obrigatórias
(`DATABASE_URL`, `ENCRYPTION_KEY` etc. — os testes de lógica pura nunca abrem conexão real, só
precisam que `config/env.ts` não lance erro ao importar), `*.test.ts` excluído do `tsconfig.json`
de ambos pra não entrar no build de produção. `ci.yml` ganhou um step "Test server"/"Test web"
entre type-check e build.

**Ainda não cobre** (registrado como limitação, não escondido): rotas HTTP (Fastify), os 3
clients de LLM, VtexClient/ShopifyClient (incluindo o fix do PUT não-parcial), e nenhum teste de
integração contra Postgres/Redis reais — é uma rede de segurança parcial focada na lógica de
maior risco de regressão silenciosa, não cobertura ampla.

### Padrão de conteúdo por categoria + referências + fix de retry do Gemini (2026-08-04, nona rodada)

Motivação (discussão com o usuário): a IA de enriquecimento só usava dados do próprio produto —
sem saber quais campos a VTEX de fato aceita por categoria, e sem uma régua de "quão completo" um
bom anúncio daquela categoria deveria ser quando o produto tem pouca informação própria. A
conversa concluiu em três peças independentes, todas opcionais e aditivas (sem nenhuma, a geração
funciona exatamente como antes):

1. **Campos aceitos pela VTEX por categoria** — ao conectar (e sob demanda, botão "Sincronizar
   categorias agora"), um job de fila (`category-sync.worker.ts`, concorrência 1) percorre a árvore
   de categorias (`listCategoryTree`, 3 níveis — Departamento/Categoria/Subcategoria) e, por nó
   folha, busca os campos de especificação (`getCategoryFieldDefinitions`). **Achado testando
   contra a conta real da Mundial Acabamentos**: o endpoint documentado
   `specification/field/listByCategoryId/{id}` voltava `[]` pra toda categoria testada, mesmo uma
   com campos visivelmente configurados no admin (`DadosTécnicos`, `Cuidados`, `Selo Azul`...) — o
   endpoint certo é `listByCategoryId`'s "gêmeo" `listTreeByCategoryId`, confirmado por captura de
   tela do admin da VTEX. Filtra `IsStockKeepingUnit === false` (campo do produto, não da SKU, a
   pedido do usuário). Nunca cobre preço/estoque/categoria — APIs inteiramente separadas.
2. **DNA de conteúdo por categoria** — alvo estrutural (faixa de palavras, bullets, presença de
   FAQ/tabela de specs/garantia), nunca texto copiado. Prioridade: valor manual > consenso entre
   1-5 links de referência de mercado colados pelo usuário (extração por IA restrita a sinais
   estruturais, nunca reproduzindo a cópia original) > calculado a partir dos produtos Ouro/Prata
   já publicados da própria loja (nunca de produtos ruins — do contrário replicaria o problema que
   a feature tenta resolver). Resolvido em `category-content-profile.repo.ts`.
3. **Referência de fabricante por produto** — o oposto do item 2: ao otimizar um produto
   específico, uma URL opcional (tipicamente a página do fabricante) tem FATOS objetivos extraídos
   (specs, dimensões, garantia) e cacheados no produto, como fonte primária contra alucinação.
   Fica salva até ser trocada/removida — não precisa ser reinformada em runs futuras.

**Wiring no prompt**: `enrichment-schema.ts` ganhou `buildCategoryFieldsSuffix`/
`buildContentProfileSuffix`; os 3 clients de LLM (Claude/OpenAI/Gemini) ganharam um método genérico
`extractStructuredData` (usado pelos dois agentes novos de extração) e os 3 parâmetros novos em
`enrichProductContent`. `content-enrichment.agent.ts` resolve os três sinais direto de
`ProductRow`/`product.category` — não precisou tocar no orquestrador, já que plataforma/categoria/
fatos do fabricante já eram colunas do produto sincronizado.

**Bug real encontrado e corrigido durante a investigação**: o usuário reportou que uma otimização
recém-tentada não gerou nenhuma proposta. Causa raiz achada direto no banco de produção (via SSH
autorizado pelo usuário): a resposta do Gemini veio com caracteres acentuados corrompidos
(mojibake), invalidando o JSON — e `isRetryableGeminiError` só considerava re-tentável erro HTTP
429/5xx, não uma falha de parse local, então a tarefa falhava de vez na primeira tentativa em vez
de tentar de novo. Corrigido: falha de "invalid JSON"/"sem output_text" agora também entra no loop
de retry (`gemini.client.ts`).

**Arquivos novos**: `web-fetch.client.ts`, `reference-structure.agent.ts`, `reference-facts.agent.ts`,
`llm-client-resolver.ts`, `category-sync.orchestrator.ts` + worker, repos
`category-nodes`/`category-spec-fields`/`category-content-profile`/`category-reference-links`,
rotas `category-profiles.routes.ts` + extensão de `products.routes.ts`/`connections.routes.ts`.
UI: novas seções em `PdpConfig.tsx` (campos aceitos, DNA de conteúdo) e campo de referência do
fabricante por produto em `Runs.tsx`.

**Verificado**: type-check e build limpos nos dois projetos, suíte de testes (30/30) sem
regressão, e as 4 migrations novas aplicadas com sucesso contra um Postgres+pgvector isolado
(container descartável, não a base de produção).

### Reorganização da Configuração de PDP + lote de 3 links de referência (2026-08-04, décima rodada)

Pedido do usuário depois de usar a tela em produção pela primeira vez: reordenar as seções (campos
aceitos pela VTEX e DNA de conteúdo primeiro, já que são o contexto que alimenta a geração; a
estrutura de blocos/preview do PDP depois) e remover "Padrões de Otimização por Categoria" da
página (o usuário não viu mais sentido em customizar os limites Ouro/Prata/Bronze por categoria).
Removida só a seção/estado dessa tela (`PdpConfig.tsx`) — as rotas `/api/optimization-thresholds`,
a tabela `category_score_thresholds` e `classifyScore` continuam existindo e sendo usados (badge de
classificação no RunDetail), só não há mais UI própria pra editar os limites por categoria.

**Bug real reportado pelo usuário no mesmo teste**: adicionar um link de referência voltava
"Internal Server Error" sem detalhe. Causa raiz dupla:
1. O front-end (`web/src/api/client.ts`'s `request()`) sempre lia `body.error` como a mensagem de
   erro — funciona para os erros que as próprias rotas tratam (`reply.status(400).send({ error:
   "mensagem real" })`), mas o handler padrão do Fastify para uma exceção não tratada manda
   `{ statusCode: 500, error: "Internal Server Error", message: "<motivo real>" }` — `error` ali é
   só a frase padrão do status HTTP, o motivo de verdade fica em `message`. Corrigido pra preferir
   `body.message ?? body.error`, então qualquer 500 futuro (nesta rota ou qualquer outra) mostra o
   motivo real em vez do texto genérico.
2. Como consequência, não dá mais pra confirmar qual exceção não tratada causou aquele 500
   específico (o log real ficou só no `docker logs` da VPS, não capturado aqui) — mas o motivo
   também deixou de importar: a rota inteira foi reescrita para nunca mais deixar a falha de UM
   link derrubar a requisição (ver abaixo).

**Mudança de UX pedida junto**: em vez de adicionar um link por vez (um `POST` por URL, uma tela
que trava se um link falhar no meio), agora até `MAX_REFERENCE_LINKS` (3, reduzido do "1 a 5"
original) URLs são coladas de uma vez e processadas numa única requisição
(`POST /api/category-reference-links` agora recebe `urls: string[]`, não mais `url: string`) — cada
URL busca+extrai isolada via `Promise.allSettled`, então uma falha (site fora do ar, bloqueio de
bot, etc.) aparece no array `errors` da resposta sem derrubar as outras nem gerar 500. O total de
links por categoria é limitado a `MAX_REFERENCE_LINKS` no servidor (`category-reference-links.repo.ts`),
não só no formulário. `docs/README.md`/`pipeline-flow.ts` atualizados de "1-5" para "até 3, em lote".

### Segundo bug real de NaN + unificação da Configuração de PDP por categoria (2026-08-04, décima primeira rodada)

Testando a rodada anterior contra um link real (padovani.com.br), surgiu um segundo bug de
robustez: "invalid input syntax for type integer: NaN" ao adicionar o link. Causa: a extração por
IA (`reference-structure.agent.ts`) não garantia que `wordCount`/`bulletCount` viessem como número
de verdade — um campo ausente ou não numérico virava `NaN` na consolidação (`median()` em
`category-reference-links.repo.ts`), que o Postgres rejeita ao gravar numa coluna `integer`.
Corrigido em duas camadas: (1) `reference-structure.agent.ts` agora sanitiza a resposta da IA
(`sanitizeSignals`/`toSafeCount`) antes mesmo dela sair do módulo — nunca mais confia que o schema
JSON foi de fato respeitado pelo provedor; (2) `recomputeReferenceProfile` também filtra pra número
finito antes do cálculo, defesa em profundidade contra qualquer linha antiga já salva com valor
ruim. `recomputeReferenceProfile` também passou a rodar dentro de try/catch na rota — uma falha ali
não derruba mais os links que já foram salvos com sucesso na mesma requisição.

Pedido do usuário depois de usar a tela em produção: unificar a Configuração de PDP em torno de UM
seletor de categoria só. Hoje a tela tinha 3 escopos diferentes emendados (lista de todas as
categorias pros campos VTEX, um seletor próprio pro DNA de conteúdo, e uma estrutura Médio/Bom/
Excelente sempre catálogo-inteiro) — o usuário queria: seleciona a subcategoria (ou categoria, se
não houver subcategoria) uma vez, e define ali mesmo os campos aceitos, o DNA de conteúdo, e a
estrutura dos 3 níveis pra ESSA categoria especificamente.

- **Achado ao implementar**: `pdp_templates` (tabela) e `resolvePdpTemplate` (caminho de
  publicação) já suportavam override por categoria desde a rodada de Configuração de PDP original —
  só a rota/UI administrativa (`GET/PUT /api/pdp-templates`) nunca expunham isso, sempre lendo/
  escrevendo só a categoria `'*'` (catálogo inteiro). Pior: o `getPdpTemplates` antigo assumia "uma
  linha por nível" sem filtrar por categoria — se uma segunda categoria algum dia tivesse ganhado
  linha própria, essa função already pegaria a linha errada silenciosamente. Reescrito pra resolver
  por (plataforma, categoria, nível) com a mesma prioridade do publish-time (específica da categoria
  > `'*'` > padrão de fábrica), retornando também `source: "specific" | "default"` pra a tela avisar
  se aquele nível já foi customizado ali ou está herdando o padrão geral.
- **Decisão confirmada com o usuário**: manter a opção "Todas as categorias (padrão)" no seletor —
  categorias ainda não configuradas continuam herdando esse padrão, em vez de cair direto no valor
  de fábrica do sistema sem contexto nenhum.
- **UI**: um card "Grupo de produtos" no topo (seletor + botão de sincronizar) substitui os 3
  escopos separados. "Campos aceitos pela VTEX" e "DNA de conteúdo" só aparecem quando uma categoria
  específica está selecionada (não fazem sentido pro catálogo inteiro); a estrutura Médio/Bom/
  Excelente aparece sempre, com o aviso de herança/customização acima descrito.

### Escrita real na VTEX: KeyWords e Specification API, validadas ao vivo (2026-08-04, décima segunda rodada)

Com o token real da VTEX finalmente em uso (billing do Gemini ativado, primeira otimização
completa do dia rodada com sucesso), o usuário revisou o produto real publicado e apontou dois
problemas que só apareceriam contra dados de verdade:

1. **"Ver na loja" apontava pro domínio errado** — `VtexClient.getProduct` construía a URL a partir
   de `{account}.{environment}.com.br` (o domínio bruto hospedado pela VTEX), não do domínio próprio
   da loja (`mundialacabamentos.com.br`). A API pública de busca (`fetchProductSpecifications`, já
   chamada pra atributos/marca/categoria) já retorna o campo `link` de verdade — só nunca tinha sido
   aproveitado aqui. Corrigido reaproveitando essa mesma chamada, sem custo de request extra.
2. **`keywords` "não tinha onde publicar na VTEX"** — documentado (errado) desde a rodada anterior.
   O usuário, olhando o admin da VTEX, apontou o campo "Palavras similares" (Frente de Loja) — uma
   busca ao vivo contra `GET /pvt/product/{id}` confirmou um campo real `KeyWords`, gravável pelo
   mesmo endpoint já usado por Title/MetaTagDescription. Implementado.

**Pedido maior do usuário**: validar e corrigir de verdade as especificações técnicas — na aba
"Características do Produto" real da VTEX, não só mescladas como HTML dentro da Descrição (que é
tudo que `technical_specs` fazia até aqui). Investigação ao vivo contra a conta real (com
autorização do usuário pra testar escrita, não só leitura):

- `GET /pvt/product/{id}/specification` retorna os valores atuais: `{Id, ProductId, FieldId,
  FieldValueId, Text}` — bate com os `FieldId`s que `category_spec_fields` já sincroniza.
- **Escrita real**: `PUT /pvt/product/{id}/specificationvalue`. Documentação pública não expõe o
  schema do corpo — descoberto por tentativa e erro controlado (erros de validação 400 revelando
  campos faltando) até chegar em `{FieldId: number, FieldValues: string[]}`.
- **Achado crítico, corrigido antes de virar código**: a primeira tentativa usou `FieldName`
  (`"Marca"`) em vez de `FieldId` — a chamada retornou 200 (sucesso!), mas criou um campo **novo e
  duplicado** ("Marca" com FieldId diferente, em outro grupo/tipo) no produto real, em vez de
  atualizar o campo existente. Revertido na hora (`DELETE /pvt/product/{id}/specification/{id}`,
  confirmado por getback). Reproduzido de novo só com `FieldId` (o que `category_spec_fields` já
  fornece) — reaproveitou a linha existente corretamente, sem duplicar. **Só `FieldId` é seguro；
  nunca escrever por `FieldName`.**
- Implementado `VtexClient.updateProductSpecificationValues` (um request por campo — o endpoint não
  aceita lote) e wireado em `publisher.agent.ts` pros dois proposals relevantes:
  - `technical_specs`: além do bloco HTML já mesclado na descrição, cada label que casa com um
    campo aceito da categoria também é escrito na aba real (best-effort, não desfaz o publish da
    descrição se falhar).
  - `attributes_patch`: o que casar com um campo da categoria vai pra Specification API real; o
    resto continua caindo em `updateProductMetafields` (caminho do Shopify, no-op na VTEX).
- `ShopifyClient` ganhou os dois métodos como no-op (Shopify já tem os próprios caminhos reais pra
  isso — metafields).

**Também corrigido nessa rodada**: os deltas do banner "Confiança de conteúdo" (RunDetail e
`/impact`) mostravam "pp" (pontos percentuais) — tecnicamente correto pra diferença entre dois
percentuais, mas o usuário reportou que os analistas do negócio não reconheciam a sigla. Trocado
pra "%", priorizando familiaridade do público sobre precisão técnica, por pedido explícito.

**Achado à parte, não é bug**: Evaluator e Content Enrichment em produção estão roteados pro
**mesmo modelo exato** (`gemini-3.6-flash`) — o roteamento padrão do código já previa provedores
diferentes pra evitar a IA julgar o próprio texto, mas com só o Gemini conectado hoje, os dois
caíram no mesmo lugar. Métricas de "Confiança de conteúdo" desta fase devem ser lidas como
indicativo otimista, não neutro, até um segundo provedor (Claude/OpenAI) ser conectado.

## Formação de equipes

- 1 a 5 pessoas por equipe (pode ser solo)
- Líder do time faz o cadastro na plataforma
- Ferramenta livre: Claude Code, qualquer IA, ou Deco Studio (créditos opcionais, não afeta julgamento)
- Cada equipe submete **uma** solução para a trilha

## Entregáveis obrigatórios

1. Repositório público no GitHub com o código
2. Vídeo demonstrando o agente em ação
   - **Confirmado pelo usuário: 5 minutos.** (Página do evento era ambígua — "Intro & Regras" dizia até 5 min, "Trilhas" dizia até 3 min — 5 min é o valor correto, resolve a divergência.)
3. Descrição do problema atacado, o que o agente faz, e impacto esperado (venda a mais / custo a menos)

## Critérios de avaliação

| Critério | O que é avaliado |
|---|---|
| **Impacto no Negócio** | Quão claro e grande é o impacto numa operação real de alto volume: mais receita ou menos custo, de preferência com métrica |
| **Execução Técnica** | Qualidade da implementação — o agente realmente funciona, arquitetura e uso adequado das ferramentas escolhidas |
| **Originalidade** | Quão diferente a abordagem é do que já existe no mercado de e-commerce, e que ângulo novo ela traz |
| **Aplicabilidade Real** | A solução roda numa operação real de loja de alto volume? Maturidade, custo de adoção, potencial de virar produto |
| **Apresentação** | Clareza do pitch e do vídeo, capacidade de mostrar o agente em ação e comunicar o valor pra loja |

**Implicações práticas para o desenvolvimento:**
- Priorizar um problema com **métrica de impacto clara e mensurável** (ex: "+X% conversão", "-Y ms de latência", "-Z% de custo de suporte") — não basta funcionar, precisa mostrar o número.
- O agente **precisa rodar de verdade**, não ser só um mockup — julgamento técnico avalia execução real.
- Vale a pena diferenciar de soluções já comuns no mercado (não reinventar um chatbot genérico).
- Pensar em cenário de adoção real (loja de alto volume) desde o design, não só como protótipo de hackathon.
- Vídeo curto e objetivo é parte da nota — roteirizar a demo com antecedência.

## Julgamento

Time da Deco escolhe os vencedores da trilha avaliando os critérios acima. Em paralelo, a
comunidade vota nos destaques (não define o prêmio oficial). Ranking fica **privado até os
organizadores publicarem os resultados**.

## Prêmios

- 🥇 1º lugar: R$ 5.000
- 🥈 2º lugar: R$ 3.000
- 🥉 3º lugar: R$ 2.000
- + Créditos Deco Studio para construir (opcional)

## Para quem é

Devs/engenheiros, tech leads/arquitetos, produto/design, agências/integradores,
plataformas/parceiros de tecnologia, pessoas de marca/operação de loja com perfil técnico.

## FAQ rápido

- Deco Studio é obrigatório? Não, ferramenta livre.
- Custa algo? Não, inscrição gratuita, 100% online.
- Pode ser solo? Sim, até time de 5.
- Precisa ser do e-commerce? Não, precisa resolver um problema real de loja online.

## Pendências / a confirmar

- [x] Confirmar limite real de duração do vídeo (3 min vs 5 min) — **5 minutos**, confirmado pelo usuário.
- [ ] Conteúdo da aba "Docs & Mídia" (provável: APIs/recursos técnicos da Deco relevantes pro build)
- [ ] Conteúdo das abas "Equipes" e "Submissões" (provavelmente listas dinâmicas de participantes — baixa prioridade)
