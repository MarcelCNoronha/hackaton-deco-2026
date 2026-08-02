import { GoogleGenAI } from "@google/genai";
import type { RequestLogEntry } from "./http.js";
import { computeCostUsd } from "./model-recommendations.js";
import { GEO_QUESTIONS, type ContentEvaluation, type EnrichedContent, type LlmClient, type ReuseReference } from "./llm-types.js";

interface GeminiInteraction {
  output_text?: string;
  steps?: Array<{ type: string; [key: string]: unknown }>;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
}

/** Thin client around the Gemini Interactions API (`@google/genai`, generally-available surface —
 *  the older `models.generateContent` is kept only for backward compatibility upstream and is not
 *  used here). Same shape/logging contract as ClaudeClient/OpenAiClient. One instance is bound to
 *  a single model (see model_routing / Connections panel). */
export class GeminiClient implements LlmClient {
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly onAttempt?: (entry: RequestLogEntry) => void | Promise<void>,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  private async loggedCall<T>(params: {
    operation: string;
    productId?: number;
    call: () => Promise<GeminiInteraction>;
    extract: (interaction: GeminiInteraction) => T;
  }): Promise<T> {
    const startedAt = Date.now();
    try {
      const interaction = await params.call();
      const inputTokens = interaction.usage?.total_input_tokens ?? 0;
      const outputTokens = interaction.usage?.total_output_tokens ?? 0;
      const costUsd = computeCostUsd("gemini", this.model, inputTokens, outputTokens);
      await this.onAttempt?.({
        provider: "gemini",
        operation: params.operation,
        endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
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
      return params.extract(interaction);
    } catch (err) {
      await this.onAttempt?.({
        provider: "gemini",
        operation: params.operation,
        endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
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

  /** Enforces the response as JSON matching `schema` via `response_format` — tried forced
   *  function-calling (`tool_choice.allowed_tools`) first, but that came back flaky in practice
   *  (sometimes no function_call step at all, sometimes malformed arguments), failing whole runs.
   *  `response_format` constrains the output directly against the schema instead of depending on
   *  the model "deciding" to call a function.
   *
   *  `thinking_level: "minimal"` is load-bearing, not cosmetic: without it, this model spends most
   *  of `max_output_tokens` on internal reasoning (observed 767 of 800 tokens as `total_thought_tokens`
   *  in one call), leaving the response truncated mid-JSON (`status: "incomplete"`) — which is what
   *  was actually causing the "invalid JSON"/"no function_call" failures, not the extraction method. */
  private async callWithSchema<T>(params: {
    operation: string;
    productId?: number;
    systemInstruction: string;
    input: unknown;
    schema: Record<string, unknown>;
    maxOutputTokens?: number;
  }): Promise<T> {
    return this.loggedCall<T>({
      operation: params.operation,
      productId: params.productId,
      call: () =>
        this.client.interactions.create({
          model: this.model,
          system_instruction: params.systemInstruction,
          input: JSON.stringify(params.input),
          response_format: { type: "text", mime_type: "application/json", schema: params.schema },
          generation_config: {
            max_output_tokens: params.maxOutputTokens ?? 1500,
            thinking_level: "minimal",
          },
        }) as unknown as Promise<GeminiInteraction>,
      extract: (interaction) => {
        if (!interaction.output_text) {
          throw new Error(`Gemini did not return output_text for ${params.operation}`);
        }
        try {
          return JSON.parse(interaction.output_text) as T;
        } catch {
          throw new Error(
            `Gemini returned invalid JSON for ${params.operation}: ${interaction.output_text.slice(0, 200)}`,
          );
        }
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
  }): Promise<EnrichedContent> {
    return this.callWithSchema<EnrichedContent>({
      operation: "enrichProductContent",
      productId: product.productId,
      systemInstruction:
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
        " Gere também: (1) 'benefitBullets' — 4 a 6 frases curtas e diretas com os principais benefícios/" +
        "diferenciais, separadas do texto corrido da descrição; (2) 'technicalSpecs' — especificações técnicas " +
        "em formato rótulo+valor, baseadas exclusivamente nos dados fornecidos ('attributes' e o texto em " +
        "'currentDescription'), nunca inventando uma especificação que não conste em nenhum dos dois; " +
        "(3) 'faq' com 6 a 10 perguntas reais que um comprador pesquisaria " +
        "(uso, compatibilidade, cuidados, comparação com variações do produto), não só as básicas. Para " +
        "'structuredData', preencha apenas campos descritivos do schema.org/Product (name, description, " +
        "category, additionalProperty a partir de technicalSpecs) — NUNCA inclua price, offers ou availability, " +
        "esses dados são preenchidos separadamente com informação real.",
      input: {
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
      },
      schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          benefitBullets: {
            type: "array",
            items: { type: "string" },
            description: "4 a 6 frases curtas de benefício/diferencial, separadas da descrição corrida.",
          },
          technicalSpecs: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, value: { type: "string" } },
              required: ["label", "value"],
            },
            description:
              "Baseado exclusivamente em 'attributes' e no texto de 'currentDescription' — nunca invente uma especificação que não conste em nenhum dos dois.",
          },
          faq: {
            type: "array",
            items: {
              type: "object",
              properties: { question: { type: "string" }, answer: { type: "string" } },
              required: ["question", "answer"],
            },
          },
          structuredData: {
            type: "object",
            description:
              "Objeto schema.org/Product válido (@context, @type, name, description, additionalProperty, ...). " +
              "Nunca inclua price, offers ou availability.",
          },
        },
        required: ["description", "benefitBullets", "technicalSpecs", "faq", "structuredData"],
      },
    });
  }

  async evaluateContent(params: {
    text: string;
    knownFacts?: string | null;
    productId?: number;
  }): Promise<ContentEvaluation> {
    return this.callWithSchema<ContentEvaluation>({
      operation: "evaluateContent",
      productId: params.productId,
      systemInstruction:
        "Você avalia um texto de produto de e-commerce como se fosse: (1) um comprador que só tem esse texto " +
        "pra decidir a compra, e (2) um assistente de IA tentando responder perguntas de um comprador usando " +
        "somente esse texto. Seja rigoroso — não dê nota alta a texto vago ou genérico.",
      input: {
        text: params.text,
        knownFacts: params.knownFacts ?? null,
        geoQuestions: GEO_QUESTIONS,
      },
      schema: {
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
      maxOutputTokens: 800,
    });
  }

  async generateAltText(params: { imageUrl: string; productTitle: string; productId?: number }): Promise<string> {
    const imageResponse = await fetch(params.imageUrl);
    const mimeType = imageResponse.headers.get("content-type") ?? "image/jpeg";
    const data = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");

    return this.loggedCall<string>({
      operation: "generateAltText",
      productId: params.productId,
      call: () =>
        this.client.interactions.create({
          model: this.model,
          system_instruction:
            "Gere um alt-text em português para a imagem de produto: descreva objetivamente o que a imagem " +
            "mostra, incluindo o nome do produto de forma natural. Máximo 125 caracteres. Responda só com o texto.",
          input: [
            { type: "image", data, mime_type: mimeType },
            { type: "text", text: `Produto: ${params.productTitle}` },
          ],
          generation_config: { max_output_tokens: 200, thinking_level: "minimal" },
        }) as unknown as Promise<GeminiInteraction>,
      extract: (interaction) => (interaction.output_text ?? "").trim(),
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.interactions.create({
        model: this.model,
        input: "ping",
        generation_config: { max_output_tokens: 8 },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
