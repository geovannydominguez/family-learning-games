import type { QuestionImage } from "./types.ts";

export const maxImageAssetIdLength = 128;
export const maxImageAltTextLength = 200;

/**
 * Logical asset IDs are lowercase path-like slugs such as `animals/dolphin-01`.
 * The shape alone rules out URLs (`https://…`), data URIs (`data:…`),
 * `javascript:` URLs and bucket/object-style references.
 */
const assetIdPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*){0,3}$/;
const unsafeAltTextPattern = /[<>]|javascript:|data:|https?:\/\/|[\u0000-\u001F\u007F]/i;

export function isValidImageAssetId(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxImageAssetIdLength && assetIdPattern.test(value);
}

export function isValidImageAltText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxImageAltTextLength && !unsafeAltTextPattern.test(trimmed);
}

/** FR-0806 / FR-0852: a learning image needs a logical asset ID and bounded, plain-text alt text. */
export function isValidQuestionImage(value: unknown): value is QuestionImage {
  if (!value || typeof value !== "object") return false;
  const image = value as Partial<QuestionImage>;
  return isValidImageAssetId(image.assetId) && isValidImageAltText(image.altText);
}
