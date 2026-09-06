import type { Category, Difficulty, Question } from "../../domain/game/types.ts";

/**
 * Provider-neutral hint about a question that a previous attempt got wrong, so
 * the generator can avoid repeating it. Same shape the reviewer reports, but
 * declared here to keep `GameGenerator` independent from `GameValidator`.
 */
export interface PreviousGenerationIssue {
  questionIndex: number;
  type: string;
  reason: string;
}

export interface GenerateGameRequest {
  topic: string;
  difficulty: Difficulty;
  /**
   * The generation BATCH SIZE for THIS call — the exact number of questions the
   * response must contain: 10 on the first round, `missingCount` (1..9) on a
   * repair round. It is NOT the final game size (always 10); every consumer must
   * honour this value and never substitute 10.
   */
  questionCount: number;
  targetAge: number;
  /** Present only on a regeneration after a rejected draft. */
  previousIssues?: readonly PreviousGenerationIssue[];
  /**
   * Verbatim text of questions already accepted for this game. A repair round
   * must not reproduce any of them. Provider-neutral: plain strings only.
   */
  existingQuestions?: readonly string[];
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
  /** The generation call returned a batch whose size ≠ the requested count. */
  | "unexpected_question_count"
  | "answer_count"
  | "correct_answer_count"
  | "duplicate_question_id"
  | "duplicate_answer_id"
  | "duplicate_text"
  | "difficulty_mismatch"
  | "category_mismatch"
  | "field_length"
  | "missing_required_field";

/**
 * Content-free summary of a Bedrock Guardrail intervention: which policies and
 * filter types fired and the action taken. It never carries the flagged word,
 * PII match, prompt text, or model output — only enumerated tokens.
 */
export interface GuardrailAssessmentSummary {
  /** Guardrail id/version — deployment configuration values, not secrets. */
  guardrailId?: string;
  guardrailVersion?: string;
  assessments: Array<{ policy: string; type: string; action: string; confidence?: string }>;
}

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
  /** Present only for `guardrail_intervened` / `content_filtered`. */
  guardrail?: GuardrailAssessmentSummary;
}

const safeStopReasonPattern = /^[a-z][a-z_]{0,39}$/;
const safeValidationFieldPattern =
  /^[A-Za-z_][A-Za-z0-9_]*(\[\d{1,3}\])?(\.[A-Za-z_][A-Za-z0-9_]*(\[\d{1,3}\])?)*$/;
const safeGuardrailTokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;

/** A Bedrock stop reason is only surfaced when it is a short, enumerated token. */
export function isSafeStopReason(value: unknown): value is string {
  return typeof value === "string" && safeStopReasonPattern.test(value);
}

/** Enumerated tokens only (policy names, filter types, actions, guardrail ids). */
export function isSafeGuardrailToken(value: unknown): value is string {
  return typeof value === "string" && safeGuardrailTokenPattern.test(value);
}

function sanitizeGuardrailSummary(summary: GuardrailAssessmentSummary | undefined): GuardrailAssessmentSummary | undefined {
  if (!summary) return undefined;
  const assessments = summary.assessments
    .filter((entry) => isSafeGuardrailToken(entry.policy) && isSafeGuardrailToken(entry.type) && isSafeGuardrailToken(entry.action))
    .slice(0, 16)
    .map((entry) => ({
      policy: entry.policy,
      type: entry.type,
      action: entry.action,
      ...(isSafeGuardrailToken(entry.confidence) ? { confidence: entry.confidence as string } : {}),
    }));
  return {
    ...(isSafeGuardrailToken(summary.guardrailId) ? { guardrailId: summary.guardrailId } : {}),
    ...(isSafeGuardrailToken(summary.guardrailVersion) ? { guardrailVersion: summary.guardrailVersion } : {}),
    assessments,
  };
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
    const guardrail = sanitizeGuardrailSummary(failure.guardrail);
    this.failure = {
      failureType: failure.failureType,
      ...(failure.validationRule ? { validationRule: failure.validationRule } : {}),
      ...(isSafeValidationField(failure.validationField) ? { validationField: failure.validationField } : {}),
      ...(isSafeStopReason(failure.stopReason) ? { stopReason: failure.stopReason } : {}),
      ...(guardrail ? { guardrail } : {}),
    };
  }
}
