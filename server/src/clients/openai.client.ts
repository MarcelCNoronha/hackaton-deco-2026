import OpenAI from "openai";
import type { RequestLogEntry } from "./http.js";
import { computeCostUsd } from "./model-recommendations.js";
import { GEO_QUESTIONS, type ContentEvaluation, type EnrichedContent, type LlmClient, type ReuseReference } from "./llm-types.js";

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
  }): Promise<EnrichedContent> {
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
        " Gere também: (1) 'benefitBullets' — 4 a 6 frases curtas e diretas com os principais benefícios/" +
        "diferenciais, separadas do texto corrido da descrição; (2) 'technicalSpecs' — especificações técnicas " +
        "em formato rótulo+valor, baseadas exclusivamente nos dados fornecidos ('attributes' e o texto em " +
        "'currentDescription'), nunca inventando uma especificação que não conste em nenhum dos dois; " +
        "(3) 'faq' com 6 a 10 perguntas reais que um comprador pesquisaria " +
        "(uso, compatibilidade, cuidados, comparação com variações do produto), não só as básicas. Para " +
        "'structuredData', preencha apenas campos descritivos do schema.org/Product (name, description, " +
        "category, additionalProperty a partir de technicalSpecs) — NUNCA inclua price, offers ou availability, " +
        "esses dados são preenchidos separadamente com informação real.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
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
            },
          ],
        },
      ],
      toolName: "submit_enriched_content",
      toolDescription: "Envia a descrição enriquecida, FAQ e dados estruturados do produto.",
      parameters: {
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
        },
        required: ["buyerConfidence", "buyerUnanswered", "geoAnswerableCount", "unsupportedClaims"],
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
