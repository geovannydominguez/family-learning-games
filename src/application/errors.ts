export type ApplicationErrorCode =
  | "INVALID_REQUEST"
  | "RESOURCE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "INVALID_SESSION_STATE"
  | "SESSION_CONFLICT"
  | "GAME_ID_CONFLICT"
  | "INVALID_GENERATION_REQUEST"
  | "AI_GENERATION_DISABLED"
  | "AI_GENERATION_FAILED"
  | "AI_GENERATION_BLOCKED"
  | "AI_GENERATED_CONTENT_INVALID"
  // v0.9.3 global daily generation quota (ADR-021)
  | "AI_GENERATION_QUOTA_EXCEEDED"
  | "INVALID_PLAYER"
  | "INVALID_PLAYER_AGE"
  | "PLAYER_NOT_FOUND"
  | "PLAYER_CONFLICT"
  | "QUESTION_AUDIO_DISABLED"
  | "QUESTION_AUDIO_UNSUPPORTED"
  | "QUESTION_AUDIO_FAILED"
  // v0.9 multiplayer (ADR-018/019/020)
  | "MULTIPLAYER_DISABLED"
  | "ROOM_NOT_FOUND"
  | "ROOM_EXPIRED"
  | "ROOM_ALREADY_STARTED"
  | "ROOM_FULL"
  | "PLAYER_ALREADY_JOINED"
  | "INVALID_PARTICIPANT_TOKEN"
  | "NOT_IDENTIFIED"
  | "HOST_ONLY_ACTION"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_ROOM_STATE"
  | "INVALID_QUESTION_STATE"
  | "ANSWER_ALREADY_SUBMITTED"
  | "ANSWER_DEADLINE_EXPIRED"
  | "INVALID_QUESTION"
  | "INVALID_ANSWER";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplicationError";
  }
}

/**
 * v0.9.3 (ADR-021): the global daily generation quota is exhausted. Carries the
 * seconds until the next local-day period so HTTP can send `Retry-After`.
 */
export class GenerationQuotaExceededError extends ApplicationError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("AI_GENERATION_QUOTA_EXCEEDED", "The daily AI game generation quota has been reached.");
    this.name = "GenerationQuotaExceededError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export class PersistenceError extends Error {
  readonly operation: string;
  readonly resourceId: string | undefined;
  readonly originalErrorName: string;

  constructor(operation: string, originalError: unknown, resourceId?: string) {
    super("Persistence operation failed.");
    this.name = "PersistenceError";
    this.operation = sanitizeOperation(operation);
    this.resourceId = sanitizeResourceId(resourceId);
    this.originalErrorName = sanitizeErrorName(originalError);
  }
}

function sanitizeOperation(value: string): string {
  return /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : "unknown-operation";
}

function sanitizeResourceId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9._~-]{1,128}$/.test(value) ? value : undefined;
}

function sanitizeErrorName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error) || typeof error.name !== "string") return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name) ? error.name : "UnknownError";
}
