# Claude review notes - Auditoria pragmatica

Contexto confirmado pelo usuario:

- A aplicacao roda em uma VPS com proxy reverso completo e acesso restrito.
- E um backoffice usado por pessoas confiaveis.
- O objetivo desta nota e separar riscos reais de producao, hardening de seguranca e pontos que podem afetar desempenho.

## Pausa / retomada em 2026-08-07

Estado antes de parar:

- Codigo enviado em `main`: commit `7dcef99 Add image regeneration instructions`.
- Deploy de producao concluido com sucesso.
- VPS validada com `IMAGE_TAG=sha-7dcef99`.
- Containers `app`, `web` e `worker` rodando; `/health` publico respondeu 200 e API interna respondeu `{"ok":true}`.
- Build local validado:
  - `server`: `npm run build`;
  - `server`: `npm test` com 63 testes passando;
  - `web`: `npm run build`.

Fluxo novo implementado:

- `RunDetail`: imagem gerada por IA agora tem `Aceitar e publicar` e `Refazer`.
- `Refazer` exige instrucao pontual e cria uma nova imagem, mantendo a antiga para comparacao/exclusao.
- A run ganhou `imageGenerationNote` no `scope`, editavel pela tela da run.
- Endpoint novo: `PATCH /api/runs/:id/image-generation-note`.
- Geracao manual e geracao do worker combinam: regra da categoria + orientacao da run + instrucao pontual.
- Seletor de otimizacao permite definir orientacao de imagens antes de criar a run.

O que falta amanha:

- Teste manual em producao na run `12`: abrir a imagem incorreta, escrever a correcao (ex.: manter quantidade exata de hastes), clicar `Refazer`, comparar a nova com a antiga e excluir a errada.
- Validar o fluxo de `Aceitar e publicar` com cuidado na VTEX quando a imagem correta estiver pronta.
- Se a geracao falhar, checar primeiro conexao/billing/quota da chave Gemini de producao antes de mexer em codigo.
- Depois disso, seguir para as proximas evolucoes do `HACKATHON.md`.

## Resultado da validacao local

- `server`: `npm run build` passou.
- `server`: `npm test` passou, 6 arquivos e 55 testes.
- `web`: `npm run build` passou.
- `web`: `npm test` passou, 1 arquivo e 5 testes.
- `npm audit` falhou inicialmente nos dois projetos por dependencias vulneraveis.
- Depois dos ajustes:
  - `web npm audit --audit-level=moderate` passou sem vulnerabilidades;
  - `server npm audit --omit=dev --audit-level=moderate` passou sem vulnerabilidades;
  - `server npm audit --audit-level=moderate` ainda aponta vulnerabilidade moderada em dependencia transiente dev-only do `drizzle-kit` mais recente (`@esbuild-kit/esm-loader` -> `@esbuild-kit/core-utils` -> `esbuild@0.18.x`). Nao entra na imagem runtime, que usa `npm ci --omit=dev`.
- Varredura simples de segredos versionados nao encontrou chaves reais.
- Apos a analise foram criadas apenas notas de documentacao (`docs/CLAUDE_REVIEW_NOTES.md` e `docs/README.md`).

## Resultado da validacao na VPS

Validacao feita por SSH em `46.202.144.198`, sem expor valores de `.env` e sem alterar producao.

- Host: Ubuntu 24.04.4 LTS.
- O login da VPS indicou 10 updates disponiveis e `System restart required`.
- Projeto Docker Compose: `/opt/catalogia`, nome `catalogia-prod`.
- Containers ativos e sem restart/OOM no momento da checagem:
  - `catalogia-prod-web-1`
  - `catalogia-prod-app-1`
  - `catalogia-prod-worker-1`
  - `catalogia-prod-db-1`
  - `catalogia-prod-valkey-1`
- Recursos no momento da leitura estavam folgados:
  - app: ~99 MiB de 512 MiB;
  - worker: ~91 MiB de 512 MiB;
  - web: ~3 MiB de 128 MiB;
  - db: ~33 MiB de 1 GiB;
  - valkey: ~5 MiB de 256 MiB.
- Banco ainda pequeno. Maiores tabelas observadas:
  - `agent_request_logs`: ~1123 linhas, 336 kB;
  - `enrichment_proposals`: ~56 linhas, 184 kB;
  - `products`: ~7 linhas, 152 kB;
  - `generated_images`: 0 linhas, 96 kB.
- Logs recentes filtrados por erro/alerta nao mostraram problemas relevantes.
- Health interno da API respondeu `{"ok":true}` dentro do container `app`.
- Health do Nginx respondeu 200 em HTTP e HTTPS.
- A imagem em producao estava em tag `sha-626f7a6`; o working copy local estava em outro commit (`6c89187`) durante a auditoria. Nao assumir que local e producao estao sincronizados antes de deploy.

### Achados operacionais da VPS

- `ufw` estava inativo no inicio da auditoria.
- Portas publicadas no host: 22, 80 e 443.
- App, Postgres e Valkey nao estavam publicados no host; ficam internos na rede Docker.
- SSH estava com, no inicio:
  - `PermitRootLogin yes`;
  - `PasswordAuthentication yes`;
  - `PubkeyAuthentication yes`.
- A origem respondia por IP direto em `http://46.202.144.198/health` e `https://46.202.144.198/health`.
- O Nginx usa `server_name _` nos blocos 80/443, entao responde para qualquer host que chegue nele.
- Logs do Nginx tinham trafego Cloudflare e tambem probes/scans diretos contra o IP da VPS.
- Conclusao inicial: o proxy reverso estava funcionando, mas a VPS nao estava restrita em firewall a Cloudflare/proxy-only.
- O `.env` de producao contem as chaves esperadas (`SESSION_COOKIE_SECRET`, `APP_BASE_URL`, `RESEND_*`, etc.), mas `IMAGE_NAME`, `IMAGE_TAG` e `WEB_IMAGE_NAME` aparecem duplicadas. Isso e uma limpeza operacional, nao incidente.

### Hardening aplicado na VPS

Aplicado em 2026-08-06 sem reboot e sem reiniciar containers.

- SSH:
  - `PermitRootLogin` ficou `without-password`;
  - `PasswordAuthentication` ficou `no`;
  - `KbdInteractiveAuthentication` ficou `no`;
  - acesso por chave foi testado apos reload do SSH.
- Firewall:
  - `ufw` ativado;
  - entrada padrao negada;
  - saida padrao liberada para preservar VTEX, Google, OpenAI, Anthropic, Gemini, Resend e demais APIs externas;
  - SSH 22 liberado;
  - 80/443 liberados apenas para ranges oficiais atuais da Cloudflare.
- Docker:
  - como portas publicadas por Docker podem contornar parte do UFW, foi criada regra no `DOCKER-USER` para permitir 80/443 somente a Cloudflare;
  - foi criado o servico `catalogia-cloudflare-firewall.service` para reaplicar essas regras apos reboot/restart do Docker.
- Validacoes apos hardening:
  - `https://app.assessoriadigitalvicosa.com.br/health` respondeu 200;
  - IP direto `http://46.202.144.198/health` e `https://46.202.144.198/health` passaram a bloquear por timeout;
  - API interna respondeu `{"ok":true}`;
  - saida externa a partir do container app continuou funcionando.

### Limpeza de imagens Docker

Foi criado `scripts/prune-production-images.sh` para limpar imagens antigas deixadas por deploys consecutivos.

- O script roda em dry-run por padrao; remocao real exige `--execute`.
- Mira apenas os repositorios da aplicacao declarados em `IMAGE_NAME` e `WEB_IMAGE_NAME`.
- Remove somente tags que casam com `sha-*`.
- Nunca remove image IDs usados por containers existentes.
- Mantem 3 tags antigas recentes por repositorio para rollback.
- Por padrao remove apenas tags com pelo menos 24 horas.
- Tambem planeja/executa `docker image prune` para imagens dangling antigas.
- O workflow `.github/workflows/deploy-production.yml` copia o script para a VPS e o executa apos health check bem-sucedido do deploy.
- Dry-run em producao encontrou candidatos antigos.
- A limpeza foi executada manualmente em 2026-08-06:
  - imagens locais cairam de 60 para 26;
  - tamanho total local caiu para ~1.5 GB;
  - containers permaneceram ativos, sem restart.

### Volumetria real das referencias recentes

Consulta em producao encontrou 5 referencias recentes, com 3 URLs unicas:

- Celite: HTML ~420 KB, 63 scripts, scripts ~257 KB, 0 JSON-LD, texto visivel ~2269 palavras, 1 imagem candidata.
- Loja Dexco: HTML ~1.55 MB, 58 scripts, scripts ~1.41 MB, 1 JSON-LD ~4.8 KB, texto visivel ~103 palavras, 1 imagem candidata.
- Padovani: HTML ~1.23 MB, 87 scripts, scripts ~759 KB, 1 JSON-LD ~847 B, texto visivel ~1559 palavras, 8 imagens candidatas.

Conclusao:

- O conteudo em scripts e importante, especialmente em paginas VTEX/hidratadas.
- O fetch de referencia deve continuar lendo HTML bruto e processando JSON-LD/hydration scripts.
- Limite de HTML em 5 MB e suficiente para as referencias reais observadas, com folga sobre o maior caso (~1.55 MB).
- Imagens devem aceitar mais de 4 candidatas; ha anuncio real com 8 imagens.
- Limite por imagem deve ser bem maior que miniaturas. Foi adotado limite conservador de 25 MB por imagem, com ate 8 tentativas.

## Prioridade real

1. Fechar borda da VPS com cuidado.
   - Antes de mexer em firewall, garantir que o login por chave funciona em uma segunda sessao.
   - Desabilitar senha para root/SSH depois de confirmar acesso por chave.
   - Se a origem deve ser Cloudflare-only, liberar 80/443 apenas para ranges oficiais da Cloudflare e manter SSH liberado para um IP administrativo confiavel.
   - Isto e seguranca operacional; nao deve melhorar performance.

2. Atualizar dependencias vulneraveis.
   - Ja atualizado no repo: `drizzle-orm`, `googleapis`, React, React Router, Vite, TypeScript e demais libs principais.
   - Pendente apenas audit dev-only do `drizzle-kit` mais recente, sem impacto no runtime de producao.
   - Isto independe do proxy reverso.

3. Conferir ambiente de producao.
   - `SESSION_COOKIE_SECRET` e obrigatorio no `server/src/config/env.ts`, mas precisa estar presente no template/secret usado na VPS.
   - `APP_BASE_URL` deve estar fixo em producao.
   - `RESEND_API_KEY` e `RESEND_FROM_EMAIL` devem estar configurados se reset/invite por email estiver ativo.

4. Configurar `trustProxy` no Fastify, de forma restrita ao proxy.
   - Sem isso, `req.ip` pode virar o IP do proxy.
   - Impacta principalmente rate-limit e logs, nao desempenho.

## Seguranca/hardening, nao desempenho

Estes pontos nao devem atrapalhar performance em si; sao principalmente robustez e defesa:

- CSRF/origin checks para metodos mutaveis.
- Headers de seguranca, se ainda nao estiverem no proxy: HSTS, CSP/frame-ancestors, Referrer-Policy.
- Remover fallback que retorna `resetUrl` no endpoint publico de forgot-password em `NODE_ENV=production`.
- Tratar `customHtml` de PDP como recurso avancado/de alto privilegio. Se continuar exposto, considerar sanitizacao ou allowlist de tags.
- Manter CORS com allowlist, como ja esta hoje.

Com o modelo atual (VPS restrita + backoffice confiavel), esses itens sao hardening recomendado, nao bloqueadores operacionais.

## Pontos que podem afetar desempenho

1. Catalogo/status calculado em memoria.
   - `server/src/api/routes/catalog.routes.ts` carrega todos os produtos locais em alguns fluxos e calcula status/counts em memoria.
   - Funciona bem em volume pequeno/moderado.
   - Para catalogos grandes, migrar para SQL com agregacoes/window functions.

2. Polling em `RunDetail`.
   - `web/src/pages/RunDetail.tsx` consulta varios endpoints a cada 5s enquanto a tela esta aberta.
   - Tambem busca imagens geradas por produto.
   - Para muitos produtos por run, considerar endpoint agregado ou SSE/WebSocket.

3. Imagens em base64 no banco/API.
   - `generated_images.image_base64` funciona para hackathon/backoffice moderado.
   - Em volume real, mover para object storage ou servir por URL/stream e retornar metadados na listagem.

4. Mermaid/bundle.
   - O build web avisou chunks grandes por Mermaid/Cytoscape.
   - Hoje a pagina de arquitetura usa import dinamico, entao o impacto principal fica em quem abre essa pagina.

5. URLs externas de referencia.
   - Fetch de paginas/fotos externas pode deixar a acao lenta quando o site externo demora.
   - Ja existe timeout no HTML, mas download de imagem deve ganhar timeout/limite tambem.

## SSRF: classificacao no contexto atual

Risco rebaixado por ser backoffice confiavel, mas ainda vale corrigir por defesa simples.

Motivo:

- O proxy reverso protege entrada.
- SSRF e chamada de saida feita pela propria aplicacao a partir da VPS.
- Se alguem cadastrar sem querer uma URL interna, ou se uma conta confiavel for comprometida, o app pode tentar acessar `localhost`, rede Docker, IPs privados ou metadata.

Recomendacao pragmatica:

- Aceitar apenas `http` e `https`.
- Bloquear `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, IPv6 local/private.
- Resolver DNS e validar o IP final antes de conectar.
- Revalidar em redirects.
- Aplicar timeout e limite de bytes por streaming tambem para imagens.

## Ordem sugerida para o Claude retomar

1. Confirmar apos deploy que a imagem nova sobe com Node 26 e health ok.
2. Revisar se o audit dev-only do `drizzle-kit` deve ser aceito documentado ou se preferem remover a ferramenta do install normal e usa-la via `npx`.
3. Se houver queixa real de lentidao, atacar nesta ordem: status/counts de catalogo em SQL, endpoint agregado para RunDetail, imagens fora do banco.

## Pendencias herdadas do HACKATHON.md

O `HACKATHON.md` tambem tem itens pendentes/para depois. Antes de implementar qualquer um, confirmar
se ainda fazem sentido, porque parte do arquivo e historico vivo e alguns pontos antigos ja foram
resolvidos pelo codigo atual.

### Produto/backlog ainda relevante

- Analytics completo de otimizacoes:
  - historico de gastos mes a mes;
  - quantidade de otimizacoes por tipo de campo;
  - analise por nivel/tier de modelo usado.
  - Base provavel: `agent_request_logs`, sem tabela nova inicialmente.

- Analytics agregado Google + otimizacoes:
  - implementado em 2026-08-06 na pagina Impacto;
  - foco principal: acessos e retorno financeiro;
  - mede consolidado e produto a produto usando primeira publicacao como pivo;
  - leitura preliminar apos 3 dias: GA4/acessos/receita para decidir cedo se o anuncio esta
    respondendo;
  - leitura madura apos 14 dias: GSC/SEO entra no agregado sem misturar dado organico ainda frio;
  - janela de comparacao: 28 dias antes contra ate 28 dias depois;
  - GSC maduro: impressoes, cliques, CTR, posicao media;
  - GA4 preliminar/maduro: sessoes, sessoes engajadas, compras, taxa de compra e receita;
  - o detalhe individual do produto segue a mesma regra: antes de 3 dias fica aguardando, de 3 a
    13 dias mostra GA4 preliminar, e a partir de 14 dias mostra GA4 + GSC;
  - regra de isolamento: listas/contadores/impacto global usam somente a plataforma ativa
    (`vtex` ou `shopify`), para anuncios de teste de uma plataforma nao aparecerem na outra;
  - receita prioriza item-level (`itemRevenue`/`itemsPurchased`) quando `itemId` casa com SKU/ID do
    produto, com fallback para receita por pagina quando o e-commerce por item nao estiver
    disponivel.

- Palavras recomendadas/proibidas e instrucoes por campo/foto por categoria:
  - implementado em 2026-08-06 como regra de linguagem/compliance por plataforma + categoria;
  - caso confirmado pelo usuario: bloquear palavras proibidas como "medicamento" em Suplementos;
  - tabela: `category_prompt_rules`, com fallback `'*'`;
  - rotas: `GET/PUT /api/category-prompt-rules`;
  - UI: bloco "Regras de linguagem e compliance" em `PdpConfig.tsx`;
  - texto: os 3 clients recebem `buildCategoryPromptRulesSuffix`;
  - seguranca funcional: `content-enrichment.agent.ts` faz checagem deterministica e retry/reprova se termo proibido escapar;
  - imagem: `generateProductImage` aplica instrucoes persistidas por tipo de foto como nota padrao.

- Reiteracao/refacao de imagens geradas incorretas:
  - implementado em 2026-08-06 na tela `RunDetail`;
  - no card da imagem gerada, o operador agora tem `Aceitar e publicar` e `Refazer`;
  - `Refazer` exige uma instrucao curta e cria nova imagem, mantendo a anterior para comparacao/exclusao;
  - a run tambem ganhou `imageGenerationNote` no `scope`, editavel por `PATCH /api/runs/:id/image-generation-note`;
  - o prompt de imagem agora combina: regra da categoria + orientacao da run + instrucao pontual da refacao/geracao manual;
  - o seletor de otimizacao permite preencher a orientacao da run antes de disparar imagens em massa.

- Geracao de video curto de produto:
  - video gerado entre 15 e 30 segundos;
  - nao confundir com o video de demo do hackathon, que tem limite de 5 minutos;
  - seguir padrao de agent/client/rota usado pela geracao de imagem.

- Editor/otimizacao de paginas de Marca, Departamento, Categoria e Subcategoria:
  - esclarecido pelo usuario em 2026-08-06: nao e apenas template de PDP por marca/departamento;
  - objetivo e criar/otimizar paginas alem da pagina de produto, por exemplo uma pagina de Marca com editor, blocos, conteudo SEO/GEO, imagens e preview;
  - precisa modelar tipos de pagina, API/editor proprios e possivel publicacao/leitura na plataforma ativa;
  - heranca editorial provavel: subcategoria > categoria > departamento > marca > `'*'`.

- Possivel migracao dos clients LLM para LangChain:
  - anotado como manutenibilidade futura, nao requisito para terminar;
  - so revisitar se bugs de saida estruturada por provedor voltarem a ser frequentes.

### Infra/operacao a confirmar com usuario/VPS

- Senha root da VPS:
  - `HACKATHON.md` marca como nao verificado;
  - confirmar se `PasswordAuthentication no` ja foi aplicado no SSH.

- Conexoes em producao:
  - confirmar se VTEX/Shopify, Anthropic/OpenAI/Gemini e Google foram recadastradas no banco de producao.

- Google Analytics Data API em producao:
  - `GscClient.testConnection()` e `Ga4Client.testConnection()` retornaram ok em 2026-08-06;
  - a consulta real `properties/{ga4PropertyId}:runReport`, usada pelo painel de Impacto, retornou
    HTTP 403 porque a API `analyticsdata.googleapis.com` ainda nao foi usada/ativada no projeto
    Google Cloud `230497389153`;
  - acao necessaria: ativar "Google Analytics Data API" nesse projeto e aguardar a propagacao;
  - o codigo agora trata falha de GSC/GA4 como ausencia de dados para nao derrubar o painel.

- Chave Gemini/billing:
  - houve registro de 429 `limit: 0` para modelo de imagem;
  - confirmar se a chave de producao pertence ao projeto com billing ativo quando a geracao de imagem for prioridade.

- VTEX `addProductImage`:
  - HACKATHON/Docs indicam que parte da VTEX foi validada ao vivo, mas upload/publicacao de imagem ainda merece smoke test cuidadoso contra conta real.

### Itens de submissao/hackathon

- Conteudo da aba "Docs & Midia".
- Conteudo das abas "Equipes" e "Submissoes".
- Roteiro do video de demo de ate 5 minutos.
- Nota narrativa: ranking real no Google leva tempo; usar GSC como linha de base e impacto estimado/medido quando maturar.
- Definir como narrar impacto de GEO sem uma metrica padrao de mercado.

### Itens provavelmente desatualizados

- Credenciais VTEX e primeiro deploy aparecem como pendentes em trechos antigos, mas secoes posteriores indicam deploy concluido e validacoes reais. Tratar como historico, nao como backlog, salvo confirmacao contraria.
- CORS permissivo aparece como pendencia antiga, mas ja foi corrigido com allowlist em `server/src/api/server.ts`.
- Descricao HTML rica aparece como ideia antiga, mas ja foi implementada pelos niveis Bom/Excelente e Configuracao de PDP.

## Leitura final

Para o contexto descrito pelo usuario, a aplicacao esta funcionalmente ok. Os pontos mais urgentes sao manutencao de dependencias e configuracao de producao. A maior parte dos demais itens e hardening de seguranca. Os pontos de desempenho existem, mas so devem virar prioridade se o catalogo/run crescer ou se houver lentidao observada em uso real.
