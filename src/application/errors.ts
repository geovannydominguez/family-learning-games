export type ApplicationErrorCode =
  | "INVALID_REQUEST"
  | "RESOURCE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "INVALID_SESSION_STATE";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ApplicationError";
  }
}
