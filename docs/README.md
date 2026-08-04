# Documentação — CatalogIA

Material de apoio gerado durante o desenvolvimento (hackathon Agents for Commerce). Cada item
abaixo tem uma fonte viva no repositório, atualizada junto do código — sem link de Artifact
externo (decisão: manter duas cópias em sincronia era a mesma duplicação que a auditoria de
código morto tentou evitar). No app, tudo isso fica atrás da permissão de Integrações (menu
"Documentação" → "Arquitetura" / "Referência de APIs").

## Fluxo atual (ponta a ponta)

- **Fonte viva**: [`web/src/lib/pipeline-flow.ts`](../web/src/lib/pipeline-flow.ts).
- **No app**: página "Arquitetura" (`/architecture`), seção "Fluxo atual".

1. **Setup** (Integrações) — conecta VTEX ou Shopify, Google (GSC+GA4), provedores de IA;
   roteamento de modelos; Padrões de Otimização (limites de score por categoria); Configuração de
   PDP (blocos/ordem por nível).
2. **Criar uma otimização** (Produtos) — escolhe produtos, nível (Médio/Bom/Excelente), tom, quais
   campos gerar, alt-text, geração de imagem por IA (sempre opt-in).
3. **O run** — Catalog Reader sincroniza; Analyst prioriza por GSC/GA4 se houver corte por Top N;
   por produto: Content Enrichment chama o LLM roteado (consulta metafields conhecidos antes,
   visão real pra escolher foto no nível Excelente) → Evaluator julga na régua de 8 sub-scores e
   pede correção até 3 tentativas, guardando a melhor; produto muito parecido reaproveita conteúdo
   já aprovado (RAG); Image Alt-Text roda separado; geração de imagem por IA (se marcada) passa
   por um gate de integridade (até 2 tentativas, nunca aprova produto "parecido").
4. **Revisão humana** (RunDetail) — aprovar/editar/rejeitar cada proposta; score antes→depois,
   badge de classificação (Ouro/Prata/Bronze — vocabulário deliberadamente diferente do nível
   Médio/Bom/Excelente escolhido antes de gerar), banner de Impacto Estimado, aviso de
   integridade nas fotos geradas.
5. **Publicar** — o Publisher busca o template de PDP certo (plataforma+categoria+nível) e monta
   a descrição final na ordem configurada (texto corrido no Médio, HTML real no Bom/Excelente);
   SEO title/meta, tags (Shopify), dados estruturados/keywords (Shopify Metafields), atributos
   normalizados (casa com metafield existente ou cria um) publicam nativamente onde a plataforma
   suporta; fotos geradas por IA publicam por um botão dedicado (bloqueado no servidor se a
   integridade não foi confirmada).
6. **Medir impacto** (Impacto) — histórico real de GSC/GA4 por produto + banner agregado.

### Riscos conhecidos (validar antes de escopo novo)

1. **VTEX nunca foi testada contra uma conta real** — todo o código VTEX roda contra a loja real
   pela primeira vez só depois do token chegar.
2. **Escrita de atributos/metafields só funciona no Shopify** — o diferencial mais novo não
   aparece com dado real na loja de verdade (VTEX) ainda.
3. **Casamento de GSC/GA4 é só por URL** — sem SKU, falha silenciosa se a URL não bater.
4. **Score é auto-avaliado pela própria IA** — rotulado como "estimado", mas vale ter a resposta
   pronta pra "quem garante que a nota significa algo real".
5. **Sem limite de concorrência entre produtos** num run — risco de custo/rate-limit conhecido,
   não testado sob carga real.
6. **Zero teste automatizado** — tudo validado por type-check/build manual.

## Diagrama de arquitetura

Fluxo completo do pipeline multi-agente (Analyst → Content Enrichment ↔ Evaluator → Publisher,
com os dois ciclos de auto-correção — conteúdo e imagem).

- **Fonte viva**: [`web/src/lib/architecture-diagram.ts`](../web/src/lib/architecture-diagram.ts).
- **No app**: página "Arquitetura" (`/architecture`, renderizado com Mermaid, client-side).

## Referência de APIs

Inventário campo a campo de toda operação externa que o pipeline chama (VTEX, Shopify, Google
Search Console, GA4, Claude, OpenAI, Gemini, Resend) — método, endpoint, tipo (leitura/escrita),
campos enviados/lidos, e as ressalvas relevantes (ex: o bug do PUT não-parcial da VTEX).

- **Fonte viva**: [`web/src/lib/api-reference.ts`](../web/src/lib/api-reference.ts).
- **No app**: página própria "Referência de APIs" (`/api-reference`), uma aba por sistema.

## Configuração de PDP

Preview de verdade (não um mockup estático) — configurável por nível, renderizado pela mesma
função (`renderPdpHtml`) que publica de fato. Também reúne, na mesma tela, os Padrões de
Otimização por Categoria (limites de score Ouro/Prata/Bronze).

- **Fonte viva**: [`web/src/pages/PdpConfig.tsx`](../web/src/pages/PdpConfig.tsx).
- **No app**: página "Configuração de PDP" (`/pdp-config`).
