# Documentação — CatalogIA

Material de apoio gerado durante o desenvolvimento (hackathon Agents for Commerce). Cada item
abaixo tem uma versão viva dentro do próprio app (quando aplicável) e uma versão publicada como
Artifact (link externo, pode expirar/ser revogado — o arquivo neste repo é a cópia permanente).

## Fluxo atual (ponta a ponta)

- **Fonte viva**: [`web/src/lib/pipeline-flow.ts`](../web/src/lib/pipeline-flow.ts).
- **No app**: aba "Arquitetura", seção "Fluxo atual".

1. **Setup** (Integrações) — conecta VTEX ou Shopify, Google (GSC+GA4), provedores de IA;
   roteamento de modelos; Padrões de Otimização (limites de score por categoria); Configuração de
   PDP (blocos/ordem por nível).
2. **Criar uma otimização** (Produtos) — escolhe produtos, nível (Médio/Bom/Excelente), tom, quais
   campos gerar, alt-text, geração de imagem por IA (sempre opt-in).
3. **O run** — Catalog Reader sincroniza; Analyst prioriza por GSC/GA4 se houver corte por Top N;
   por produto: Content Enrichment chama o LLM roteado (consulta metafields conhecidos antes,
   visão real pra escolher foto no nível Excelente) → Evaluator julga na régua de 11 métricas e
   pede correção até 3 tentativas, guardando a melhor; produto muito parecido reaproveita conteúdo
   já aprovado (RAG); Image Alt-Text roda separado; geração de imagem por IA (se marcada) passa
   por um gate de integridade (até 2 tentativas, nunca aprova produto "parecido").
4. **Revisão humana** (RunDetail) — aprovar/editar/rejeitar cada proposta; score antes→depois,
   badge de nível, banner de Impacto Estimado, aviso de integridade nas fotos geradas.
5. **Publicar** — o Publisher busca o template de PDP certo (plataforma+categoria+nível) e monta
   a descrição final na ordem configurada (texto corrido no Médio, HTML real no Bom/Excelente);
   SEO title/meta, tags (Shopify), dados estruturados/keywords (Shopify Metafields), atributos
   normalizados (casa com metafield existente ou cria um) publicam nativamente onde a plataforma
   suporta; fotos geradas por IA publicam por um botão dedicado.
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

- **Fonte viva**: [`web/src/lib/architecture-diagram.ts`](../web/src/lib/architecture-diagram.ts) —
  editar esse arquivo é o que atualiza tanto a aba "Arquitetura" do app quanto qualquer
  republicação do Artifact.
- **No app**: aba "Arquitetura" no menu lateral (renderizado com Mermaid, client-side).
- **Artifact publicado**: https://claude.ai/code/artifact/127e33b6-2099-4365-80a9-5ecc284a173e

## Referência de APIs

Inventário campo a campo de toda operação externa que o pipeline chama (VTEX, Shopify, Google
Search Console, GA4, Claude, OpenAI, Gemini) — método, endpoint, tipo (leitura/escrita), campos
enviados/lidos, e as ressalvas relevantes (ex: o bug do PUT não-parcial da VTEX).

- **Fonte viva**: [`web/src/lib/api-reference.ts`](../web/src/lib/api-reference.ts).
- **No app**: mesma aba "Arquitetura", seção "Referência de APIs" abaixo do diagrama.
- **Artifact publicado**: https://claude.ai/code/artifact/1adde460-c296-4117-9dd7-73ccb528ac7c

## Exemplo de PDP — nível Excelente

Mockup de uma página de produto real (porcelanato, segmento "acabamentos para construção") mostrando
exatamente o que o nível **Excelente** gera — cada bloco leva uma etiqueta indicando qual campo do
CatalogIA o preencheu (`seo_title`, `description · structured_with_image`, `technical_specs`,
`faq`, `keywords + tags`, `structured_data`, `cta`).

- **Arquivo neste repo**: [`docs/exemplos/pdp-nivel-excelente.html`](./exemplos/pdp-nivel-excelente.html)
  — abra direto no navegador.
- **Artifact publicado**: https://claude.ai/code/artifact/5a74c69b-9f5d-434b-a6e4-5808ab236cd6

Este exemplo é estático (não é gerado do código) — serve pra ilustrar o resultado esperado, não
é atualizado automaticamente. Se a estrutura da PDP mudar (ver Padrões de Otimização / Estrutura
da PDP no app), vale regenerar.
