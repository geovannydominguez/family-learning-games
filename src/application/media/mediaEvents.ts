/**
 * Structured media observability (v0.8). Separate from the v0.7.1
 * Generator/Validator telemetry. Carries opaque IDs, outcomes and durations
 * only — never question/answer text, MP3 bytes, signed URLs, object keys,
 * correct-answer metadata or player data.
 */
export interface MediaEvent {
  event:
    | "QUESTION_AUDIO_REQUESTED"
    | "QUESTION_AUDIO_CACHE_HIT"
    | "QUESTION_AUDIO_CACHE_MISS"
    | "QUESTION_AUDIO_SYNTHESIZED"
    | "QUESTION_AUDIO_FAILED"
    | "QUESTION_IMAGE_RESOLVED"
    | "QUESTION_IMAGE_MISSING"
    | "QUESTION_IMAGE_FAILED";
  level: "info" | "warn" | "error";
  correlationId?: string;
  gameId?: string;
  questionId?: string;
  assetId?: string;
  cacheHit?: boolean;
  durationMs?: number;
  /** Safe failure category. */
  stage?: "synthesis" | "storage" | "signing" | "content" | "catalog";
  errorName?: string;
}

export function safeErrorName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error) || typeof error.name !== "string") return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name) ? error.name : "UnknownError";
}
