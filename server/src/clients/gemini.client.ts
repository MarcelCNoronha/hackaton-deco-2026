import { GoogleGenAI } from "@google/genai";
import type { RequestLogEntry } from "./http.js";
import { computeCostUsd, IMAGE_GENERATION_MODEL } from "./model-recommendations.js";
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

async function fetchImageDataBlock(url: string): Promise<{ type: "image"; data: string; mime_type: string }> {
  const res = await fetch(url);
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { type: "image", data, mime_type: mimeType };
}

/** Unlike VTEX/Shopify (see http.ts's requestWithRetry), calls to the Gemini SDK were never
 *  retried at all — a single 429 (e.g. a burst of concurrent per-product calls in one run briefly
 *  exceeding a free-tier RPM cap) failed that call immediately and permanently. Retrying here
 *  mirrors the same backoff pattern for the SDK surface. */
const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_BASE_DELAY_MS = 3000;
/** Wait at most this long per attempt even when Google's own error suggests longer — bounds how
 *  long one product's failure can stall the rest of the run. */
const GEMINI_MAX_BACKOFF_MS = 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Google's 429 message embeds a suggested wait (e.g. "Please retry in 51.6s") — parsed out so a
 *  real signal is honored (capped by GEMINI_MAX_BACKOFF_MS) instead of only guessing via backoff. */
function parseSuggestedRetryDelayMs(message: string): number | null {
  const match = message.match(/retry in ([\d.]+)s/i);
  return match ? Number(match[1]) * 1000 : null;
}

/** A `limit: 0` quota (seen on the image-generation model when a project's billing doesn't cover
 *  it) can never succeed no matter how long we wait, unlike a `limit: 5`-style RPM cap that
 *  resets on its own — retrying that would just waste time and hold up the rest of the run. */
function isPermanentlyExhausted(message: string): boolean {
  return /limit:\s*0\b/.test(message);
}

/** Duck-typed instead of `instanceof ApiError` — verified live in production that the thrown
 *  error's class identity doesn't reliably match across this package's ESM/CJS module boundary
 *  (instanceof silently returned false, skipping every retry). `.status` is a plain property on
 *  the real error either way; the message-prefix fallback (Google's errors read e.g. "429 You
 *  exceeded...") covers any shape that doesn't carry it. */
function extractStatusCode(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  if (err instanceof Error) {
    const match = err.message.match(/^(\d{3})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function isRetryableGeminiError(err: unknown): boolean {
  const status = extractStatusCode(err);
  return status === 429 || (status !== null && status >= 500);
}

/** Malformed-output failures thrown by `callWithSchema`'s own `extract` step (invalid JSON, empty
 *  output_text) never carry an HTTP status — `isRetryableGeminiError` alone always treats them as
 *  permanent, so a single bad generation (e.g. one response with corrupted accented characters
 *  breaking `JSON.parse`) killed the whole task with retry attempts still available. These are
 *  one-off generation quirks, not systemic failures, so they're worth retrying same as 429/5xx. */
function isTransientContentError(message: string): boolean {
  return message.includes("returned invalid JSON") || message.includes("did not return output_text");
}

/** Gemini's `response_format: {mime_type: "application/json"}` is a strong hint, not a hard
 *  guarantee — for long free-text fields (a full product description, a 6-10 item FAQ) it
 *  occasionally emits a literal newline/tab/carriage-return INSIDE a JSON string value instead of
 *  the escaped \n/\t/\r sequence. That's invalid per the JSON spec (control characters U+0000-
 *  U+001F must be escaped inside a string) and breaks `JSON.parse` even though the content itself
 *  is otherwise perfectly good — confirmed live: real production failures had well-formed,
 *  correctly-accented Portuguese text right up to the parse error, with substantial output-token
 *  counts (nowhere near maxOutputTokens), ruling out truncation as the cause. Only touches bytes
 *  that are ALREADY invalid raw JSON inside a string literal, so this can never change what valid
 *  JSON would have parsed to — it only repairs exactly the class of break this causes. */
function repairUnescapedControlChars(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (!inString) {
      result += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += char;
      escaped = false;
    } else if (char === "\\") {
      result += char;
      escaped = true;
    } else if (char === '"') {
      result += char;
      inString = false;
    } else if (char === "\n") {
      result += "\\n";
    } else if (char === "\r") {
      result += "\\r";
    } else if (char === "\t") {
      result += "\\t";
    } else {
      result += char;
    }
  }
  return result;
}

interface GeminiInteraction {
  output_text?: string;
  output_image?: { data?: string; mime_type?: string; uri?: string };
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
    let lastErr: unknown;

    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
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
          attempt,
          durationMs: Date.now() - startedAt,
          model: this.model,
          inputTokens,
          outputTokens,
          costUsd,
          productId: params.productId,
        });
        return params.extract(interaction);
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[gemini] ${params.operation} failed (attempt ${attempt}/${GEMINI_MAX_ATTEMPTS}, productId=${params.productId ?? "n/a"}): ${message}`);
        await this.onAttempt?.({
          provider: "gemini",
          operation: params.operation,
          endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
          method: "POST",
          success: false,
          attempt,
          durationMs: Date.now() - startedAt,
          error: message,
          model: this.model,
          productId: params.productId,
        });

        const retryable = (isRetryableGeminiError(err) || isTransientContentError(message)) && !isPermanentlyExhausted(message);
        if (!retryable || attempt === GEMINI_MAX_ATTEMPTS) throw err;

        const backoffMs = GEMINI_BASE_DELAY_MS * 2 ** (attempt - 1);
        const suggestedMs = parseSuggestedRetryDelayMs(message);
        await sleep(Math.min(suggestedMs ?? backoffMs, GEMINI_MAX_BACKOFF_MS));
      }
    }
    throw lastErr;
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
    /** A plain object gets JSON.stringify'd as a single text input (the common case). Pass an
     *  array of content blocks (image/text) directly for a multimodal call — see
     *  enrichProductContent's structured_with_image branch. */
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
          input: Array.isArray(params.input) ? params.input : JSON.stringify(params.input),
          response_format: { type: "text", mime_type: "application/json", schema: params.schema },
          // gemini-2.5-flash-image (the only model this class is ever instantiated with for
          // image work — see generateProductImage/verifyImageIntegrity) rejects thinking_level
          // entirely ("Thinking is not enabled for this model"), unlike the text models below
          // where "minimal" is load-bearing to avoid reasoning eating the whole output budget.
          generation_config: {
            max_output_tokens: params.maxOutputTokens ?? 1500,
            ...(this.model === IMAGE_GENERATION_MODEL ? {} : { thinking_level: "minimal" }),
          },
        }) as unknown as Promise<GeminiInteraction>,
      extract: (interaction) => {
        if (!interaction.output_text) {
          throw new Error(`Gemini did not return output_text for ${params.operation}`);
        }
        try {
          return JSON.parse(interaction.output_text) as T;
        } catch (firstErr) {
          try {
            return JSON.parse(repairUnescapedControlChars(interaction.output_text)) as T;
          } catch {
            // Real JSON.parse reason (e.g. "Bad control character in string literal at position
            // 412") was previously discarded in favor of a generic message — kept here, plus a
            // longer preview, since this is exactly the diagnostic that was missing when this
            // class of failure was last investigated live in production.
            const reason = firstErr instanceof Error ? firstErr.message : String(firstErr);
            throw new Error(
              `Gemini returned invalid JSON for ${params.operation} (${reason}): ${interaction.output_text.slice(0, 1000)}`,
            );
          }
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

    const textPayload = {
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
    };

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
      input: useVision
        ? [...(await Promise.all(candidateImageUrls.map(fetchImageDataBlock))), { type: "text", text: JSON.stringify(textPayload) }]
        : textPayload,
      schema: { type: "object", ...buildEnrichmentSchema(requestedFields, richness) },
      // Raised from 1500/2500 after a real production failure: with all 11 fields requested (the
      // "Excelente" package's default) plus a verbose description and a 6-10 item FAQ, the
      // response routinely needed more than 2500 tokens and got cut off mid-JSON ("Unterminated
      // string", "Expected property name or '}'") — not a formatting bug, genuine truncation.
      maxOutputTokens: useVision ? 6000 : 3000,
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

  /** Generates a new image FROM one or more of the product's existing photos (never from
   *  scratch) — e.g. placing the product in a realistic lifestyle setting, or a close-up calling
   *  out one feature. `costUsd` is supplied by the caller (image generation is priced per-image,
   *  not per-token, so the generic loggedCall/computeCostUsd path doesn't apply here). */
  async generateProductImage(params: {
    referenceImageUrls: string[];
    prompt: string;
    costUsd: number;
    productId?: number;
  }): Promise<{ mimeType: string; base64: string }> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      try {
        const imageBlocks = await Promise.all(
          params.referenceImageUrls.map(async (url) => {
            const res = await fetch(url);
            const mimeType = res.headers.get("content-type") ?? "image/jpeg";
            const data = Buffer.from(await res.arrayBuffer()).toString("base64");
            return { type: "image" as const, data, mime_type: mimeType };
          }),
        );

        const interaction = (await this.client.interactions.create({
          model: this.model,
          input: [...imageBlocks, { type: "text", text: params.prompt }],
          // Verified live: an explicit `delivery` value (either "inline" or "uri") is rejected on
          // this model ("Image delivery mode is not supported") — must be omitted entirely, which
          // then returns inline base64 data by default. `thinking_level` (any value) is also
          // rejected outright now ("Thinking is not enabled for this model", confirmed live
          // 2026-08-05) — must be omitted, not just given a lower value.
          response_format: { type: "image", aspect_ratio: "1:1", image_size: "1K" },
        })) as unknown as GeminiInteraction;

        let mimeType = interaction.output_image?.mime_type ?? "image/jpeg";
        let base64 = interaction.output_image?.data;
        if (!base64 && interaction.output_image?.uri) {
          // Not expected given the above, but harmless to also handle a hosted-URI response —
          // fetched and re-encoded as base64 immediately since that URI is likely transient.
          const res = await fetch(interaction.output_image.uri);
          mimeType = res.headers.get("content-type") ?? mimeType;
          base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        }
        if (!base64) {
          throw new Error("Gemini did not return an output image");
        }

        await this.onAttempt?.({
          provider: "gemini",
          operation: "generateProductImage",
          endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
          method: "POST",
          success: true,
          attempt,
          durationMs: Date.now() - startedAt,
          model: this.model,
          costUsd: params.costUsd,
          productId: params.productId,
        });

        return { mimeType, base64 };
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[gemini] generateProductImage failed (attempt ${attempt}/${GEMINI_MAX_ATTEMPTS}, productId=${params.productId ?? "n/a"}): ${message}`);
        await this.onAttempt?.({
          provider: "gemini",
          operation: "generateProductImage",
          endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
          method: "POST",
          success: false,
          attempt,
          durationMs: Date.now() - startedAt,
          error: message,
          model: this.model,
          productId: params.productId,
        });

        const retryable = isRetryableGeminiError(err) && !isPermanentlyExhausted(message);
        if (!retryable || attempt === GEMINI_MAX_ATTEMPTS) throw err;

        const backoffMs = GEMINI_BASE_DELAY_MS * 2 ** (attempt - 1);
        const suggestedMs = parseSuggestedRetryDelayMs(message);
        await sleep(Math.min(suggestedMs ?? backoffMs, GEMINI_MAX_BACKOFF_MS));
      }
    }
    throw lastErr;
  }

  /** Post-generation integrity gate for generateProductImage: compares the generated image against
   *  ONE of its reference photos and asks for an objective verdict on whether it's still the same
   *  product (no shape/color/label/material drift) — scenery/framing/lighting changes are fine.
   *  Never trusts the generation prompt alone; this is a second, independent multimodal check,
   *  mirroring the text quality-gate's discipline of judging the *output*, not just instructing it. */
  async verifyImageIntegrity(params: {
    referenceImageUrl: string;
    generatedBase64: string;
    generatedMimeType: string;
    productId?: number;
  }): Promise<{ sameProduct: boolean; notes: string }> {
    const referenceBlock = await fetchImageDataBlock(params.referenceImageUrl);
    return this.callWithSchema<{ sameProduct: boolean; notes: string }>({
      operation: "verifyImageIntegrity",
      productId: params.productId,
      systemInstruction:
        "Você compara duas imagens de um produto de e-commerce: a primeira é uma FOTO DE REFERÊNCIA real do " +
        "produto; a segunda foi gerada por IA a partir dela. Diga se a imagem gerada mostra EXATAMENTE o " +
        "mesmo produto (mesma forma, cor, material, rótulo/logo/textura) — mudanças de cenário, enquadramento " +
        "ou iluminação são aceitáveis; qualquer alteração de forma, cor, material ou rótulo NÃO é. Seja " +
        "rigoroso: na dúvida, considere que não é o mesmo produto.",
      input: [
        referenceBlock,
        { type: "image", data: params.generatedBase64, mime_type: params.generatedMimeType },
        { type: "text", text: "Primeira imagem = referência real do produto. Segunda imagem = gerada por IA a partir dela." },
      ],
      schema: {
        type: "object",
        properties: {
          sameProduct: {
            type: "boolean",
            description: "true somente se for claramente o mesmo produto, sem alteração de forma/cor/material/rótulo.",
          },
          notes: { type: "string", description: "Justificativa curta (1 frase) do veredito." },
        },
        required: ["sameProduct", "notes"],
      },
      maxOutputTokens: 200,
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
    return this.callWithSchema<T>({
      operation: params.operation,
      productId: params.productId,
      systemInstruction: params.systemInstruction,
      input: params.text,
      schema: params.schema,
      maxOutputTokens: params.maxTokens ?? 800,
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
