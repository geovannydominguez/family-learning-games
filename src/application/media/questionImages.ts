import { isValidImageAssetId, isValidQuestionImage } from "../../domain/game/questionMedia.ts";
import type { QuestionImage } from "../../domain/game/types.ts";
import { type MediaEvent, safeErrorName } from "./mediaEvents.ts";
import type { MediaObjectStore } from "./ports.ts";

/** Runtime presentation data (FR-0824). Never persisted. */
export interface PublicQuestionImage {
  url: string;
  altText: string;
}

export interface QuestionImageResolver {
  /** Never throws: an unknown, invalid or failing image degrades to `undefined` (FR-0851). */
  resolve(image: QuestionImage | undefined): Promise<PublicQuestionImage | undefined>;
}

/** One entry of the application-controlled image catalog (FR-0850). */
export interface MediaCatalogEntry {
  assetId: string;
  objectKey: string;
}

const imageObjectKeyPattern = /^images\/[a-z0-9][a-z0-9/_-]{0,200}\.(?:webp|png|jpe?g)$/;

/**
 * Resolves logical `assetId`s through a static, curated catalog and returns
 * short-lived read URLs. Only assets registered in the catalog under
 * `images/` can ever be resolved.
 */
export class CatalogQuestionImageResolver implements QuestionImageResolver {
  private readonly catalog: ReadonlyMap<string, string>;
  private readonly store: MediaObjectStore;
  private readonly urlTtlSeconds: number;
  private readonly logEvent: (event: MediaEvent) => void;

  constructor(
    catalog: readonly MediaCatalogEntry[],
    store: MediaObjectStore,
    options: { urlTtlSeconds: number; logEvent?: (event: MediaEvent) => void },
  ) {
    const entries = new Map<string, string>();
    for (const entry of catalog) {
      if (!isValidImageAssetId(entry.assetId) || !imageObjectKeyPattern.test(entry.objectKey)) {
        throw new Error(`Invalid media catalog entry: ${String(entry.assetId)}`);
      }
      entries.set(entry.assetId, entry.objectKey);
    }
    this.catalog = entries;
    this.store = store;
    this.urlTtlSeconds = options.urlTtlSeconds;
    this.logEvent = options.logEvent ?? (() => {});
  }

  async resolve(image: QuestionImage | undefined): Promise<PublicQuestionImage | undefined> {
    if (!image) return undefined;
    if (!isValidQuestionImage(image)) {
      this.logEvent({ event: "QUESTION_IMAGE_MISSING", level: "warn", stage: "content" });
      return undefined;
    }
    const objectKey = this.catalog.get(image.assetId);
    if (!objectKey) {
      this.logEvent({ event: "QUESTION_IMAGE_MISSING", level: "warn", assetId: image.assetId, stage: "catalog" });
      return undefined;
    }
    try {
      const url = await this.store.createReadUrl(objectKey, this.urlTtlSeconds);
      this.logEvent({ event: "QUESTION_IMAGE_RESOLVED", level: "info", assetId: image.assetId });
      return { url, altText: image.altText.trim() };
    } catch (error) {
      this.logEvent({ event: "QUESTION_IMAGE_FAILED", level: "error", assetId: image.assetId, stage: "signing", errorName: safeErrorName(error) });
      return undefined;
    }
  }
}
