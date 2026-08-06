import { db } from "../db/client.js";
import { generatedImages } from "../db/schema.js";
import type { GeminiClient } from "../clients/gemini.client.js";
import { IMAGE_GENERATION_PRICE_PER_IMAGE } from "../clients/model-recommendations.js";
import type { ImageInstructionKind } from "../clients/llm-types.js";
import type { ProductRow } from "./catalog-reader.agent.js";
import { safeUrlFetch } from "../clients/safe-url-fetch.js";
import { cropReferenceToJpeg, toStoreJpeg, type NormalizedCropRect } from "../lib/image-processing.js";
import { resolveCategoryPromptRules } from "../repositories/category-prompt-rules.repo.js";

export type GeneratableImageKind = ImageInstructionKind;

/** kind -> this store's VTEX photo-slot classification — see photoClassificationEnum's doc
 *  comment. 1:1 for every AI-generated kind (only a downloaded manufacturer_reference photo needs
 *  a human to pick one, since its kind doesn't imply a slot). */
export const CLASSIFICATION_BY_KIND: Record<GeneratableImageKind, "principal" | "ambientada" | "dimensional" | "destaque"> = {
  principal: "principal",
  lifestyle: "ambientada",
  dimensional: "dimensional",
  feature_callout: "destaque",
};

interface ProductImage {
  ImageUrl: string;
  ImageText?: string;
  Id?: string | number;
}

export interface ReferenceImageCrop extends NormalizedCropRect {
  imageUrl: string;
}

/** Gemini's multi-image input works best with a couple of clear references, not the whole gallery
 *  — more images raises cost and risks diluting which one the model treats as "the product". */
const MAX_REFERENCE_IMAGES = 1;
const PRINCIPAL_IMAGE_PATTERN = /principal|main|hero/i;

function selectReferenceImageUrls(images: ProductImage[]): string[] {
  return [...images]
    .filter((img) => Boolean(img.ImageUrl))
    .sort((a, b) => {
      const aText = `${a.ImageText ?? ""} ${a.ImageUrl}`;
      const bText = `${b.ImageText ?? ""} ${b.ImageUrl}`;
      const aPrincipal = PRINCIPAL_IMAGE_PATTERN.test(aText);
      const bPrincipal = PRINCIPAL_IMAGE_PATTERN.test(bText);
      return Number(bPrincipal) - Number(aPrincipal);
    })
    .slice(0, MAX_REFERENCE_IMAGES)
    .map((img) => img.ImageUrl);
}

/** "Integridade do produto é inegociável" (requisito explícito do usuário, reforçado de novo em
 *  2026-08-05: sempre deixar explícito, nunca gerar variação parecida, e frisar cor à parte por
 *  ser o desvio mais comum/sutil de um modelo de imagem) — a imagem gerada tem que mostrar O
 *  PRODUTO EXATO das fotos de referência, nunca uma variação parecida ou genérica da mesma
 *  categoria. Reforçado aqui no prompt E checado de novo depois via verifyImageIntegrity (gate
 *  independente, não confia só na instrução). */
const INTEGRITY_INSTRUCTION =
  " INTEGRIDADE DO PRODUTO É OBRIGATÓRIA: gere a cena usando O MESMO PRODUTO EXATO mostrado nas imagens de " +
  "referência — não é permitido gerar uma variação parecida, um modelo similar da mesma linha/categoria, " +
  "ou uma versão genérica. É PROIBIDO alterar a forma, o material, o rótulo/logo e, especialmente, a COR: " +
  "mantenha fielmente a mesma cor/tom/acabamento exatos do produto de referência, sem qualquer variação de " +
  "matiz, saturação ou brilho. Apenas cenário, enquadramento e iluminação ambiente podem mudar — o produto " +
  "em si deve permanecer idêntico em todos os aspectos.";

function requiredNoteInstruction(note?: string): string {
  const trimmed = note?.trim();
  if (!trimmed) return "";
  return (
    " INSTRUCAO ADICIONAL OBRIGATORIA DO OPERADOR: " +
    trimmed +
    ". Esta instrucao deve ser obedecida acima de qualquer decisao estetica. Se ela citar quantidade, conte visualmente e mostre exatamente a quantidade pedida; " +
    "nao adicione pecas, barras, hastes, suportes ou detalhes extras que nao existam no produto de referencia. Use a foto principal de referencia como fonte de geometria; " +
    "em cenas com toalhas ou objetos cobrindo parte do produto, preserve a quantidade real sem duplicar nem dividir barras visiveis nas laterais."
  );
}

const PROMPTS: Record<GeneratableImageKind, (title: string, note?: string) => string> = {
  principal: (title, note) =>
    `Gere a foto principal de e-commerce do produto "${title}": still isolado sobre fundo branco puro, ` +
    "enquadramento frontal centralizado, iluminação de estúdio uniforme, sem sombras duras nem outros " +
    "objetos de cena — o mesmo padrão de uma foto principal de catálogo." +
    INTEGRITY_INSTRUCTION +
    requiredNoteInstruction(note),
  lifestyle: (title, note) =>
    `Gere uma foto realista mostrando o produto "${title}" ambientado em um cenário de uso real e ` +
    "atraente (um ambiente bem decorado condizente com a categoria do produto)." +
    INTEGRITY_INSTRUCTION +
    requiredNoteInstruction(note),
  // AI image generation can't render precise measurement numbers reliably — this asks for a
  // clear scale/proportion reference (e.g. next to a common object) rather than promising exact
  // annotated dimensions, which the model would likely hallucinate.
  dimensional: (title, note) =>
    `Gere uma foto do produto "${title}" que ajude a comunicar seu tamanho/proporção real — mostre o ` +
    "produto inteiro, enquadramento amplo e nítido, de preferência ao lado de um objeto comum que dê " +
    "noção de escala (sem inventar números ou medidas na imagem)." +
    INTEGRITY_INSTRUCTION +
    requiredNoteInstruction(note),
  feature_callout: (title, note) =>
    `Gere uma imagem de destaque de produto para "${title}", em estilo still de e-commerce, aproximando ` +
    "(close-up) ou destacando visualmente um detalhe/característica importante do produto mostrado nas " +
    "imagens de referência (acabamento, material, mecanismo, textura)." +
    INTEGRITY_INSTRUCTION +
    requiredNoteInstruction(note),
};

/** Bounded retries for the integrity gate below — separate from (and on top of) generateProductImage's
 *  own network-level retry/backoff in gemini.client.ts. */
const MAX_INTEGRITY_ATTEMPTS = 2;
const REFERENCE_CROP_FETCH_TIMEOUT_MS = 15_000;
const REFERENCE_CROP_MAX_BYTES = 12 * 1024 * 1024;
const REFERENCE_CROP_INSTRUCTION =
  " A PRIMEIRA imagem de referencia enviada ao modelo e um RECORTE escolhido pelo operador: e o enfoque OBRIGATORIO e UNICO da cena. Gere um close-up " +
  "centrado exatamente nesse detalhe, com ele ocupando a maior parte do quadro (aproximadamente 70% a 90%). A SEGUNDA imagem mostra o produto completo e " +
  "serve APENAS para confirmar cor/material/forma exatos — nao gere uma foto aberta do produto inteiro nem baseie o enquadramento nela.";
const REFERENCE_CROP_REQUIRED_NOTE =
  "A foto de destaque deve focar exatamente no recorte selecionado pelo operador (primeira imagem de referencia): gere um close-up desse detalhe " +
  "especificamente, nunca uma foto aberta do produto inteiro.";

function productImageUrls(product: ProductRow): Set<string> {
  const images = (product.images as ProductImage[]) ?? [];
  return new Set(images.map((img) => img.ImageUrl).filter((url): url is string => Boolean(url)));
}

async function buildReferenceCropData(crop: ReferenceImageCrop): Promise<{ data: string; mimeType: string }> {
  const { response, body } = await safeUrlFetch(crop.imageUrl, {
    timeoutMs: REFERENCE_CROP_FETCH_TIMEOUT_MS,
    maxBytes: REFERENCE_CROP_MAX_BYTES,
  });
  if (!response.ok) {
    throw new Error(`Nao foi possivel baixar a imagem do recorte (HTTP ${response.status}).`);
  }

  const jpeg = await cropReferenceToJpeg(body, crop);
  return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
}

/** Generates a new marketing image FROM a product's existing photos (never from scratch) and
 *  persists it. Throws if the product has no reference images to work from — there's nothing to
 *  compose the new image against. */
export async function generateProductImage(params: {
  gemini: GeminiClient;
  product: ProductRow;
  kind: GeneratableImageKind;
  note?: string;
  /** Which of the product's own photos to use as the base reference — operator-chosen from the
   *  generation modal. Falls back to the automatic principal-pattern pick when omitted. */
  baseImageUrl?: string;
  referenceCrop?: ReferenceImageCrop;
}): Promise<typeof generatedImages.$inferSelect> {
  const { gemini, product, kind, note, baseImageUrl } = params;
  const referenceCrop = kind === "feature_callout" ? params.referenceCrop : undefined;
  const images = (product.images as ProductImage[]) ?? [];
  if (images.length === 0) {
    throw new Error("Este produto não tem nenhuma imagem cadastrada para usar como referência.");
  }

  let referenceImageUrls: string[];
  if (baseImageUrl) {
    if (!productImageUrls(product).has(baseImageUrl)) {
      throw new Error("A imagem base precisa ser uma imagem cadastrada neste produto.");
    }
    referenceImageUrls = [baseImageUrl];
  } else {
    referenceImageUrls = selectReferenceImageUrls(images);
  }
  if (referenceImageUrls.length === 0) {
    throw new Error("Este produto nÃ£o tem nenhuma imagem cadastrada para usar como referÃªncia.");
  }
  let referenceImageData: Array<{ data: string; mimeType: string }> = [];
  if (referenceCrop) {
    if (!productImageUrls(product).has(referenceCrop.imageUrl)) {
      throw new Error("O recorte precisa usar uma imagem cadastrada neste produto.");
    }
    referenceImageData = [await buildReferenceCropData(referenceCrop)];
  }

  const categoryPromptRules = await resolveCategoryPromptRules(product.platform, product.category);
  const categoryNote = categoryPromptRules?.imageInstructions[kind];
  const mergedNote = [categoryNote, note, referenceCrop ? REFERENCE_CROP_REQUIRED_NOTE : ""]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
  const prompt = PROMPTS[kind](product.title, mergedNote) + (referenceCrop ? REFERENCE_CROP_INSTRUCTION : "");

  let best: { mimeType: string; base64: string } | null = null;
  let integrityVerified = false;
  let integrityNotes = "";

  for (let attempt = 1; attempt <= MAX_INTEGRITY_ATTEMPTS; attempt++) {
    const generated = await gemini.generateProductImage({
      referenceImageUrls,
      referenceImageData,
      prompt,
      costUsd: IMAGE_GENERATION_PRICE_PER_IMAGE,
      productId: product.id,
    });
    best = generated;

    // A thrown error here (network blip, transient 5xx) is NOT a rejection verdict — treating it
    // as one would discard an already-generated, already-billed image over a connectivity issue
    // instead of just recording that verification couldn't be completed this attempt.
    try {
      const verdict = await gemini.verifyImageIntegrity({
        referenceImageUrl: referenceImageUrls[0],
        generatedBase64: generated.base64,
        generatedMimeType: generated.mimeType,
        productId: product.id,
        requiredInstruction: mergedNote,
      });
      integrityNotes = verdict.notes;
      if (verdict.sameProduct) {
        integrityVerified = true;
        break;
      }
      console.error(
        `[image-generation] integrity check failed for product ${product.id} (attempt ${attempt}/${MAX_INTEGRITY_ATTEMPTS}): ${verdict.notes}`,
      );
    } catch (err) {
      integrityNotes = `Verificação de integridade falhou (erro técnico, não reprovação): ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[image-generation] integrity check errored for product ${product.id} (attempt ${attempt}/${MAX_INTEGRITY_ATTEMPTS}):`, err);
    }
  }

  // best is guaranteed set: the loop always runs at least once. Persisted even when never
  // verified — same "always show something, but flag it" discipline as unsupportedClaims for
  // text — so it's auditable in the panel instead of silently disappearing. Normalized to this
  // store's 1000x1000 JPG convention only now (after the integrity check, not before) — no reason
  // to spend the resize on an attempt the loop might discard.
  const jpeg = await toStoreJpeg(Buffer.from(best!.base64, "base64"));
  const [row] = await db
    .insert(generatedImages)
    .values({
      productId: product.id,
      kind,
      classification: CLASSIFICATION_BY_KIND[kind],
      prompt,
      mimeType: "image/jpeg",
      imageBase64: jpeg.toString("base64"),
      costUsd: IMAGE_GENERATION_PRICE_PER_IMAGE.toString(),
      integrityVerified,
      integrityNotes,
    })
    .returning();
  return row;
}
