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
  | "AI_GENERATED_CONTENT_INVALID";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplicationError";
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
