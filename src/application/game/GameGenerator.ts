import type { Category, Difficulty, Question } from "../../domain/game/types.ts";

export interface GenerateGameRequest {
  topic: string;
  difficulty: Difficulty;
  questionCount: number;
  targetAge: number;
}

export interface GenerateGameCommand {
  topic: string;
  difficulty: Difficulty;
  questionCount: number;
  playerId: string;
  correlationId?: string;
}

export interface GeneratedGameDraft {
  title: string;
  difficulty: Difficulty;
  category: Category;
  questions: Question[];
}

export interface GameGenerator {
  generate(request: GenerateGameRequest): Promise<GeneratedGameDraft>;
}

/**
 * Internal, provider-neutral classification of a failed generation attempt.
 * Used only for observability. It never carries prompts, model output,
 * question or answer content, or any personal data.
 */
export type GenerationFailureType =
  | "guardrail_intervened"
  | "content_filtered"
  | "invalid_json"
  | "invalid_shape"
  | "validation_failed"
  | "provider_error";

export type GenerationValidationRule =
  | "question_count"
  | "answer_count"
  | "correct_answer_count"
  | "duplicate_question_id"
  | "duplicate_answer_id"
  | "duplicate_text"
  | "difficulty_mismatch"
  | "category_mismatch"
  | "field_length"
  | "missing_required_field";

export interface GeneratedGameCandidateFailure {
  failureType: GenerationFailureType;
  validationRule?: GenerationValidationRule;
  /**
   * Structural path of the offending field, built only from literal code
   * identifiers and numeric array indices (e.g. "questions[3].answers[2].id").
   * Never contains a field value, question, answer, prompt, or model output.
   */
  validationField?: string;
  stopReason?: string;
}

const safeStopReasonPattern = /^[a-z][a-z_]{0,39}$/;
const safeValidationFieldPattern =
  /^[A-Za-z_][A-Za-z0-9_]*(\[\d{1,3}\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d{1,3}\])?)*$/;

/** A Bedrock stop reason is only surfaced when it is a short, enumerated token. */
export function isSafeStopReason(value: unknown): value is string {
  return typeof value === "string" && safeStopReasonPattern.test(value);
}

/**
 * A validation field path is only surfaced when it is a dotted chain of bare
 * identifiers and bracketed integer indices. Anything else (spaces, quotes,
 * a stray value) is rejected and dropped rather than logged.
 */
export function isSafeValidationField(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && safeValidationFieldPattern.test(value);
}

export class InvalidGeneratedGameCandidateError extends Error {
  readonly failure: GeneratedGameCandidateFailure;

  constructor(failure: GeneratedGameCandidateFailure = { failureType: "validation_failed" }) {
    super("Generated game candidate is invalid.");
    this.name = "InvalidGeneratedGameCandidateError";
    this.failure = {
      failureType: failure.failureType,
      ...(failure.validationRule ? { validationRule: failure.validationRule } : {}),
      ...(isSafeValidationField(failure.validationField) ? { validationField: failure.validationField } : {}),
      ...(isSafeStopReason(failure.stopReason) ? { stopReason: failure.stopReason } : {}),
    };
  }
}
