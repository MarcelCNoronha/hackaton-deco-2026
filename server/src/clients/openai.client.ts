import OpenAI from "openai";
import type { RequestLogEntry } from "./http.js";
import { computeCostUsd } from "./model-recommendations.js";
import {
  buildCategoryFieldsSuffix,
  buildContentProfileSuffix,
  buildDescriptionRichnessSuffix,
  buildEnrichmentInstructionSuffix,
  buildEnrichmentSchema,
  buildKnownAttributeFieldsSuffix,
  buildTopSearchQueriesSuffix,
  resolveRequestedFields,
} from "./enrichment-schema.js";
import {
  GEO_QUESTIONS,
  type CommunicationTone,
  type ContentEvaluation,
  type DescriptionRichness,
  type EnrichedContent,
  type EnrichmentField,
  type LlmClient,
  type ReuseReference,
} from "./llm-types.js";

/** Caps how many existing product photos get sent in one multimodal call (structured_with_image
 *  richness) — enough to give the model real choice without an unbounded per-product image cost. */
const MAX_FEATURED_IMAGE_CANDIDATES = 6;

function toneInstruction(tone?: CommunicationTone): string {
  if (!tone || tone === "auto") return "";
  const label = { premium: "premium/sofisticado", tecnico: "técnico/direto", casual: "casual/próximo" }[tone];
  return ` Tom de comunicação: ${label}.`;
}

/** Thin client around the OpenAI Responses API — same shape/logging contract as ClaudeClient, so
 *  every pipeline task can pick either provider without the agents caring which one they got.
 *  One instance is bound to a single model (see model_routing / Connections panel). */
export class OpenAiClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  private async loggedCall<T>(params: {
    operation: string;
    productId?: number;
    call: () => Promise<OpenAI.Responses.Response>;
    extract: (response: OpenAI.Responses.Response) => T;
  }): Promise<T> {
    const startedAt = Date.now();
    try {
      const response = await params.call();
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const costUsd = computeCostUsd("openai", this.model, inputTokens, outputTokens);
      await this.onAttempt?.({
        provider: "openai",
        operation: params.operation,
        endpoint: "https://api.openai.com/v1/responses",
        method: "POST",
        success: true,
        attempt: 1,
        durationMs: Date.now() - startedAt,
        model: this.model,
        inputTokens,
        outputTokens,
        costUsd,
        productId: params.productId,
      });
      return params.extract(response);
    } catch (err) {
      await this.onAttempt?.({
        provider: "openai",
        operation: params.operation,
        endpoint: "https://api.openai.com/v1/responses",
        method: "POST",
        success: false,
        attempt: 1,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        model: this.model,
        productId: params.productId,
      });
      throw err;
    }
  }

  /** Forces a single function call so the response is always well-formed JSON. */
  private async callWithTool<T>(params: {
    operation: string;
    productId?: number;
    instructions: string;
    input: OpenAI.Responses.ResponseInput;
    toolName: string;
    toolDescription: string;
    parameters: Record<string, unknown>;
    maxOutputTokens?: number;
  }): Promise<T> {
    return this.loggedCall<T>({
      operation: params.operation,
      productId: params.productId,
      call: () =>
        this.client.responses.create({
          model: this.model,
          instructions: params.instructions,
          max_output_tokens: params.maxOutputTokens ?? 1500,
          input: params.input,
          tools: [
            {
              type: "function",
              name: params.toolName,
              description: params.toolDescription,
              parameters: params.parameters,
              strict: false,
            },
          ],
          tool_choice: { type: "function", name: params.toolName },
        }),
      extract: (response) => {
        const call = response.output.find((item) => item.type === "function_call");
        if (!call || call.type !== "function_call") {
          throw new Error(`OpenAI did not return a function_call for ${params.operation}`);
        }
        return JSON.parse(call.arguments) as T;
      },
    });
  }

  async enrichProductContent(product: {
    title: string;
    currentDescription: string | null;
    attributes: Record<string, unknown>;
    category: string | null;
    feedback?: { buyerUnanswered: string[]; unsupportedClaims: string[] } | null;
    reuseReference?: ReuseReference | null;
    productId?: number;
    fields?: EnrichmentField[];
    descriptionRichness?: DescriptionRichness;
    communicationTone?: CommunicationTone;
    imageUrls?: string[];
    knownAttributeFields?: Array<{ key: string; name: string }>;
    topSearchQueries?: string[];
    categoryFields?: Array<{ name: string }>;
    contentProfile?: {
      wordCountMin: number | null;
      wordCountMax: number | null;
      bulletCount: number | null;
      hasFaq: boolean | null;
      hasSpecTable: boolean | null;
      hasWarrantySection: boolean | null;
    } | null;
    manufacturerFacts?: Record<string, string> | null;
  }): Promise<EnrichedContent> {
    const requestedFields = resolveRequestedFields(product.fields);
    const richness = product.descriptionRichness ?? "plain";
    const candidateImageUrls = (product.imageUrls ?? []).slice(0, MAX_FEATURED_IMAGE_CANDIDATES);
    const useVision = richness === "structured_with_image" && candidateImageUrls.length > 0;

    const textPayload = JSON.stringify({
      title: product.title,
      currentDescription: product.currentDescription,
      attributes: product.attributes,
      category: product.category,
      ...(product.feedback
        ? {
            correcaoNecessaria: {
              perguntasSemResposta: product.feedback.buyerUnanswered,
              alegacoesNaoSustentadas: product.feedback.unsupportedClaims,
            },
          }
        : {}),
      ...(product.reuseReference ? { referencia: product.reuseReference } : {}),
      ...(useVision ? { fotosDisponiveis: candidateImageUrls } : {}),
      ...(product.manufacturerFacts ? { especificacoesFabricante: product.manufacturerFacts } : {}),
    });

    return this.callWithTool<EnrichedContent>({
      operation: "enrichProductContent",
      productId: product.productId,
      instructions:
        (product.reuseReference
          ? "Você está adaptando o conteúdo de um produto MUITO similar (campo 'referencia' abaixo) para este " +
            "novo produto — não escreva do zero. Preserve a estrutura, tom e nível de detalhe da referência, mas " +
            "corrija título, medidas, cor, material, modelo ou qualquer outro atributo que seja diferente entre " +
            "os dois produtos, usando os dados de entrada como fonte da verdade. Nunca invente especificações " +
            "que não foram fornecidas."
          : "Você é um redator de e-commerce especialista em SEO e GEO (Generative Engine Optimization), " +
            "inspirado em landing pages de alta conversão. Escreva em português, de forma factual e natural — " +
            "responda 'serve pra quê' e 'compatível com o quê' sempre que fizer sentido para a categoria do " +
            "produto. Nunca invente especificações que não foram fornecidas nos dados de entrada." +
            (product.feedback
              ? " Esta é uma correção de uma tentativa anterior que não passou na revisão de qualidade — " +
                "resolva especificamente os problemas apontados em 'correcaoNecessaria', sem reintroduzi-los."
              : "")) +
        buildEnrichmentInstructionSuffix(requestedFields) +
        buildDescriptionRichnessSuffix(richness) +
        buildKnownAttributeFieldsSuffix(product.knownAttributeFields) +
        buildTopSearchQueriesSuffix(product.topSearchQueries) +
        buildCategoryFieldsSuffix(product.categoryFields) +
        buildContentProfileSuffix(product.contentProfile) +
        toneInstruction(product.communicationTone) +
        (product.manufacturerFacts
          ? " O campo 'especificacoesFabricante' vem da página oficial do fabricante deste produto específico — é " +
            "fonte primária de fatos: nunca contradiga, nunca invente valor que não esteja lá nem em 'attributes'."
          : "") +
        (useVision
          ? " As imagens anexadas a esta mensagem, na mesma ordem de 'fotosDisponiveis', são as fotos reais " +
            "já existentes do produto — use-as para escolher 'featuredImageUrl'."
          : ""),
      input: [
        {
          role: "user",
          content: useVision
            ? [
                ...candidateImageUrls.map(
                  (url) => ({ type: "input_image", image_url: url, detail: "auto" }) as const,
                ),
                { type: "input_text", text: textPayload },
              ]
            : [{ type: "input_text", text: textPayload }],
        },
      ],
      toolName: "submit_enriched_content",
      toolDescription: "Envia a descrição enriquecida, FAQ e dados estruturados do produto.",
      parameters: { type: "object", ...buildEnrichmentSchema(requestedFields, richness) },
      // Raised from 1500/2500 — see gemini.client.ts's identical fix for why (real production
      // truncation with all 11 fields + a verbose description + FAQ under the old ceiling).
      maxOutputTokens: useVision ? 6000 : 3000,
    });
  }

  async evaluateContent(params: {
    text: string;
    knownFacts?: string | null;
    productId?: number;
  }): Promise<ContentEvaluation> {
    return this.callWithTool<ContentEvaluation>({
      operation: "evaluateContent",
      productId: params.productId,
      instructions:
        "Você avalia um texto de produto de e-commerce como se fosse: (1) um comprador que só tem esse texto " +
        "pra decidir a compra, e (2) um assistente de IA tentando responder perguntas de um comprador usando " +
        "somente esse texto. Seja rigoroso — não dê nota alta a texto vago ou genérico.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                text: params.text,
                knownFacts: params.knownFacts ?? null,
                geoQuestions: GEO_QUESTIONS,
              }),
            },
          ],
        },
      ],
      toolName: "submit_evaluation",
      toolDescription: "Envia a avaliação estruturada do texto de produto.",
      parameters: {
        type: "object",
        properties: {
          buyerConfidence: {
            type: "integer",
            description: "0-100: o quanto um comprador compraria sem precisar perguntar a um vendedor.",
          },
          buyerUnanswered: {
            type: "array",
            items: { type: "string" },
            description: "Perguntas que ficariam sem resposta pra esse comprador (máx. 5).",
          },
          geoAnswerableCount: {
            type: "integer",
            description: "Quantas das perguntas em geoQuestions dá pra responder com certeza usando só o texto.",
          },
          unsupportedClaims: {
            type: "array",
            items: { type: "string" },
            description:
              "Só quando knownFacts for informado: afirmações do texto que não são suportadas por knownFacts. Vazio caso contrário.",
          },
          seoScore: {
            type: "integer",
            description: "0-100: qualidade de título/meta/palavras-chave/headings para descoberta em busca.",
          },
          conversionScore: {
            type: "integer",
            description: "0-100: clareza da chamada à ação, benefícios e resposta a objeções de compra.",
          },
          dataConsistencyScore: {
            type: "integer",
            description: "0-100: o quanto título/descrição/atributos concordam entre si, sem contradição.",
          },
          catalogIssues: {
            type: "array",
            items: { type: "string" },
            description: "Informações conflitantes ou claramente ausentes notadas ao avaliar (vazio se nenhuma).",
          },
        },
        required: [
          "buyerConfidence",
          "buyerUnanswered",
          "geoAnswerableCount",
          "unsupportedClaims",
          "seoScore",
          "conversionScore",
          "dataConsistencyScore",
          "catalogIssues",
        ],
      },
      maxOutputTokens: 800,
    });
  }

  async generateAltText(params: { imageUrl: string; productTitle: string; productId?: number }): Promise<string> {
    return this.loggedCall<string>({
      operation: "generateAltText",
      productId: params.productId,
      call: () =>
        this.client.responses.create({
          model: this.model,
          max_output_tokens: 200,
          instructions:
            "Gere um alt-text em português para a imagem de produto: descreva objetivamente o que a imagem " +
            "mostra, incluindo o nome do produto de forma natural. Máximo 125 caracteres. Responda só com o texto.",
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: params.imageUrl, detail: "auto" },
                { type: "input_text", text: `Produto: ${params.productTitle}` },
              ],
            },
          ],
        }),
      extract: (response) => response.output_text.trim(),
    });
  }

  async extractStructuredData<T>(params: {
    operation: string;
    systemInstruction: string;
    text: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
    productId?: number;
  }): Promise<T> {
    return this.callWithTool<T>({
      operation: params.operation,
      productId: params.productId,
      instructions: params.systemInstruction,
      input: [{ role: "user", content: [{ type: "input_text", text: params.text }] }],
      toolName: "extract_structured_data",
      toolDescription: "Retorna os dados extraídos no formato pedido.",
      parameters: params.schema,
      maxOutputTokens: params.maxTokens ?? 800,
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.responses.create({
        model: this.model,
        max_output_tokens: 16,
        input: "ping",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
