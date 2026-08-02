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

## Formação de equipes

- 1 a 5 pessoas por equipe (pode ser solo)
- Líder do time faz o cadastro na plataforma
- Ferramenta livre: Claude Code, qualquer IA, ou Deco Studio (créditos opcionais, não afeta julgamento)
- Cada equipe submete **uma** solução para a trilha

## Entregáveis obrigatórios

1. Repositório público no GitHub com o código
2. Vídeo demonstrando o agente em ação
   - ⚠️ **Divergência entre páginas do evento**: aba "Intro & Regras" diz até 5 min, aba "Trilhas" diz até 3 min. **Confirmar com organização** — assumir 3 min por segurança até esclarecer.
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

- [ ] Confirmar limite real de duração do vídeo (3 min vs 5 min)
- [ ] Conteúdo da aba "Docs & Mídia" (provável: APIs/recursos técnicos da Deco relevantes pro build)
- [ ] Conteúdo das abas "Equipes" e "Submissões" (provavelmente listas dinâmicas de participantes — baixa prioridade)
