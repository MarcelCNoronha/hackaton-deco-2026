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
   PDP (blocos/ordem por nível; campos aceitos pela VTEX por categoria, sincronizados
   automaticamente ao conectar; DNA de conteúdo por categoria — manual, consenso de links de
   referência de mercado, ou derivado dos próprios produtos Ouro/Prata).
2. **Criar uma otimização** (Produtos) — escolhe produtos, nível (Médio/Bom/Excelente), tom, quais
   campos gerar, alt-text, geração de imagem por IA (sempre opt-in); por produto, opcionalmente
   uma "Referência do fabricante" (URL da página oficial) pra fundamentar a geração em fatos reais.
3. **O run** — Catalog Reader sincroniza; Analyst prioriza por GSC/GA4 se houver corte por Top N;
   por produto: Content Enrichment chama o LLM roteado (consulta metafields conhecidos antes,
   visão real pra escolher foto no nível Excelente, campos aceitos + DNA da categoria + fatos do
   fabricante quando existirem) → Evaluator julga na régua de 8 sub-scores e pede correção até 3
   tentativas, guardando a melhor; produto muito parecido reaproveita conteúdo já aprovado (RAG);
   Image Alt-Text roda separado; geração de imagem por IA (se marcada) passa por um gate de
   integridade (até 2 tentativas, nunca aprova produto "parecido").
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

1. **VTEX — validada contra uma conta real (2026-08-04)** — category/tree/3,
   specification/field/listTreeByCategoryId, o PUT de produto (Title/MetaTagDescription/KeyWords) e
   a Specification API (`.../specificationvalue`, escrita real de "Características do Produto")
   foram todos testados ao vivo contra a conta da Mundial Acabamentos, incluindo um bug real achado
   e revertido no processo (escrever por FieldName duplicava a especificação — só FieldId é
   seguro). `addProductImage` segue não testado ao vivo.
2. **Escrita de atributos/technical_specs agora publica de verdade nas duas plataformas** —
   Shopify via metafields (já existia); VTEX via `updateProductSpecificationValues` na
   Specification API real (novo, 2026-08-04) — qualquer label que bata com um campo aceito da
   categoria vai pra aba "Características do Produto" de verdade, não só pro HTML da descrição.
3. **Casamento de GSC/GA4 é só por URL** — sem SKU, falha silenciosa se a URL não bater.
4. **Score é auto-avaliado pela própria IA** — rotulado como "estimado", mas vale ter a resposta
   pronta pra "quem garante que a nota significa algo real".
5. **Sem limite de concorrência entre produtos** num run — risco de custo/rate-limit conhecido,
   não testado sob carga real.
6. **Zero teste automatizado** — tudo validado por type-check/build manual.
7. **~~Deploy de produção defasado~~ — resolvido (2026-08-04, 20:47)** — o commit que adiciona
   sync de categorias VTEX, campos de especificação, DNA de conteúdo por categoria e referência de
   fabricante (`9553aaf`) passou no CI mas **falhou ao implantar na VPS** no primeiro deploy
   (timeout de conexão SSH pro runner do GitHub, bloqueio de rede transitório — ver
   `HACKATHON.md`). Um push seguinte (`fbe2093`) disparou uma nova tentativa que implantou com
   sucesso — a VPS já roda a versão com essas features.

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
