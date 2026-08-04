# Documentação — CatalogIA

Material de apoio gerado durante o desenvolvimento (hackathon Agents for Commerce). Cada item
abaixo tem uma versão viva dentro do próprio app (quando aplicável) e uma versão publicada como
Artifact (link externo, pode expirar/ser revogado — o arquivo neste repo é a cópia permanente).

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
