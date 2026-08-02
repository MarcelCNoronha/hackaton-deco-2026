import Anthropic from "@anthropic-ai/sdk";
import type { RequestLogEntry } from "./http.js";
import { computeCostUsd } from "./model-recommendations.js";
import { buildEnrichmentInstructionSuffix, buildEnrichmentSchema, resolveRequestedFields } from "./enrichment-schema.js";
import {
  GEO_QUESTIONS,
  type ContentEvaluation,
  type EnrichedContent,
  type EnrichmentField,
  type LlmClient,
  type ReuseReference,
} from "./llm-types.js";

/** Thin client around the Anthropic SDK — content enrichment (text), vision (alt-text), and evaluation.
 *  One instance is bound to a single model (the orchestrator builds one instance per pipeline task,
 *  reading the model from model_routing) — every call is logged with token usage + computed USD cost,
 *  optionally attributed to a productId for per-product cost views. */
export class ClaudeClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  /** Runs one Messages API call, logging duration + token usage + computed cost regardless of outcome. */
  private async loggedCall<T>(params: {
    operation: string;
    productId?: number;
    call: () => Promise<Anthropic.Message>;
    extract: (message: Anthropic.Message) => T;
  }): Promise<T> {
    const startedAt = Date.now();
    try {
      const message = await params.call();
      const costUsd = computeCostUsd("anthropic", this.model, message.usage.input_tokens, message.usage.output_tokens);
      await this.onAttempt?.({
        provider: "anthropic",
        operation: params.operation,
        endpoint: "https://api.anthropic.com/v1/messages",
        method: "POST",
        success: true,
        attempt: 1,
        durationMs: Date.now() - startedAt,
        model: this.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        costUsd,
        productId: params.productId,
      });
      return params.extract(message);
    } catch (err) {
      await this.onAttempt?.({
        provider: "anthropic",
        operation: params.operation,
        endpoint: "https://api.anthropic.com/v1/messages",
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

  /** Forces a single tool call so the response is always well-formed JSON — never a free-text
   *  parse that can break when the model adds prose around it. */
  private async callWithTool<T>(params: {
    operation: string;
    productId?: number;
    system: string;
    content: Anthropic.MessageParam["content"];
    toolName: string;
    toolDescription: string;
    inputSchema: Anthropic.Tool.InputSchema;
    maxTokens?: number;
  }): Promise<T> {
    return this.loggedCall<T>({
      operation: params.operation,
      productId: params.productId,
      call: () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: params.maxTokens ?? 1500,
          system: params.system,
          tools: [
            {
              name: params.toolName,
              description: params.toolDescription,
              input_schema: params.inputSchema,
            },
          ],
          tool_choice: { type: "tool", name: params.toolName },
          messages: [{ role: "user", content: params.content }],
        }),
      extract: (message) => {
        const toolUse = message.content.find((block) => block.type === "tool_use");
        if (!toolUse || toolUse.type !== "tool_use") {
          throw new Error(`Claude did not return a tool_use block for ${params.operation}`);
        }
        return toolUse.input as T;
      },
    });
  }

  /** Rewrites a product's description for SEO (traditional search) and GEO (AI-assistant citability).
   *  `feedback` carries what the Evaluator found wrong with a *previous* attempt (unanswered buyer
   *  questions, unsupported claims) so the quality-gate retry loop in content-enrichment.agent.ts
   *  can ask for a corrected draft instead of just re-rolling blindly. */
  async enrichProductContent(product: {
    title: string;
    currentDescription: string | null;
    attributes: Record<string, unknown>;
    category: string | null;
    feedback?: { buyerUnanswered: string[]; unsupportedClaims: string[] } | null;
    reuseReference?: ReuseReference | null;
    productId?: number;
    fields?: EnrichmentField[];
  }): Promise<EnrichedContent> {
    const requestedFields = resolveRequestedFields(product.fields);
    return this.callWithTool<EnrichedContent>({
      operation: "enrichProductContent",
      productId: product.productId,
      system:
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
        buildEnrichmentInstructionSuffix(requestedFields),
      content: JSON.stringify({
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
      }),
      toolName: "submit_enriched_content",
      toolDescription: "Envia a descrição enriquecida, FAQ e dados estruturados do produto.",
      inputSchema: { type: "object", ...buildEnrichmentSchema(requestedFields) },
    });
  }

  /** Judges one piece of content (original OR proposed) on the exact same rubric so scores are comparable.
   *  `knownFacts` (attributes/original description) is only meaningful when evaluating a *proposed* text —
   *  it's what lets the model flag claims that aren't actually grounded in anything we know about the product. */
  async evaluateContent(params: {
    text: string;
    knownFacts?: string | null;
    productId?: number;
  }): Promise<ContentEvaluation> {
    return this.callWithTool<ContentEvaluation>({
      operation: "evaluateContent",
      productId: params.productId,
      system:
        "Você avalia um texto de produto de e-commerce como se fosse: (1) um comprador que só tem esse texto " +
        "pra decidir a compra, e (2) um assistente de IA tentando responder perguntas de um comprador usando " +
        "somente esse texto. Seja rigoroso — não dê nota alta a texto vago ou genérico.",
      content: JSON.stringify({
        text: params.text,
        knownFacts: params.knownFacts ?? null,
        geoQuestions: GEO_QUESTIONS,
      }),
      toolName: "submit_evaluation",
      toolDescription: "Envia a avaliação estruturada do texto de produto.",
      inputSchema: {
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
        },
        required: ["buyerConfidence", "buyerUnanswered", "geoAnswerableCount", "unsupportedClaims"],
      },
      maxTokens: 800,
    });
  }

  /** Analyzes a product image and generates SEO/accessibility-optimized alt-text. */
  async generateAltText(params: { imageUrl: string; productTitle: string; productId?: number }): Promise<string> {
    const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
    type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

    const imageResponse = await fetch(params.imageUrl);
    const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
    const mediaType: SupportedMediaType = (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(contentType)
      ? (contentType as SupportedMediaType)
      : "image/jpeg";
    const imageBase64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");

    return this.loggedCall<string>({
      operation: "generateAltText",
      productId: params.productId,
      call: () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 200,
          system:
            "Gere um alt-text em português para a imagem de produto: descreva objetivamente o que a imagem " +
            "mostra, incluindo o nome do produto de forma natural. Máximo 125 caracteres. Responda só com o texto.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data: imageBase64 },
                },
                { type: "text", text: `Produto: ${params.productTitle}` },
              ],
            },
          ],
        }),
      extract: (message) => {
        const textBlock = message.content.find((block) => block.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw new Error("Claude did not return a text block for generateAltText");
        }
        return textBlock.text.trim();
      },
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
