import type { Difficulty } from "../../domain/game/types.ts";
import type { GeneratedGameDraft } from "./GameGenerator.ts";

/**
 * Provider-neutral port for a BLIND independent review of an AI-generated game
 * draft, performed AFTER structural normalization and BEFORE persistence.
 *
 * The reviewing model is NOT told which option the generator marked correct. It
 * independently solves every question. Application then deterministically
 * compares the reviewer's answer against the generator's marked answer; the
 * model has no final authority over persistence.
 *
 * The reviewer must not rewrite the game.
 */
export interface GameValidator {
  validate(request: ValidateGeneratedGameRequest): Promise<GameValidationResult>;
}

export interface ValidateGeneratedGameRequest {
  topic: string;
  difficulty: Difficulty;
  targetAge: number;
  /**
   * The structurally-valid candidate questions for this repair round (1..10 of
   * them; 4 answers each, exactly one `isCorrect`). The adapter must NOT send
   * the `isCorrect` flags to the model, and `title`/`category` are unused by it.
   */
  draft: GeneratedGameDraft;
}

/**
 * Stable review issue codes. Split by intent:
 *  - HARD codes invalidate the question (factual / structural problems).
 *  - SOFT codes are non-blocking quality observations about distractors.
 */
export type GameValidationIssueType =
  // hard — factual / structural
  | "FACTUALLY_INCORRECT"
  | "INCORRECT_ANSWER"
  | "MULTIPLE_CORRECT_ANSWERS"
  | "AMBIGUOUS_QUESTION"
  | "AGE_INAPPROPRIATE"
  | "OFF_TOPIC"
  | "INVALID_OPTIONS"
  | "FACTUAL_UNCERTAINTY"
  /** Application-only: reviewer's independent answer differs from the generator's. */
  | "ANSWER_MISMATCH"
  // soft — quality warnings, never block
  | "DIFFICULTY_MISMATCH"
  | "WEAK_DISTRACTOR"
  | "TOO_EASY_DISTRACTOR"
  | "DISTRACTOR_QUALITY";

/** Blocking severity for each code. `ANSWER_MISMATCH` is computed by Application, not sent to the LLM. */
const issueSeverityByType: Record<GameValidationIssueType, "error" | "warning"> = {
  FACTUALLY_INCORRECT: "error",
  INCORRECT_ANSWER: "error",
  MULTIPLE_CORRECT_ANSWERS: "error",
  AMBIGUOUS_QUESTION: "error",
  AGE_INAPPROPRIATE: "error",
  OFF_TOPIC: "error",
  INVALID_OPTIONS: "error",
  FACTUAL_UNCERTAINTY: "error",
  ANSWER_MISMATCH: "error",
  DIFFICULTY_MISMATCH: "warning",
  WEAK_DISTRACTOR: "warning",
  TOO_EASY_DISTRACTOR: "warning",
  DISTRACTOR_QUALITY: "warning",
};

/** Authoritative blocking severity for an issue code. Unknown codes fail safe (`error`). */
export function issueSeverity(type: GameValidationIssueType): "error" | "warning" {
  return issueSeverityByType[type] ?? "error";
}

/** Codes the reviewer LLM is allowed to return (excludes the Application-only `ANSWER_MISMATCH`). */
export const reviewerIssueTypes: readonly GameValidationIssueType[] = [
  "FACTUALLY_INCORRECT",
  "INCORRECT_ANSWER",
  "MULTIPLE_CORRECT_ANSWERS",
  "AMBIGUOUS_QUESTION",
  "AGE_INAPPROPRIATE",
  "OFF_TOPIC",
  "INVALID_OPTIONS",
  "FACTUAL_UNCERTAINTY",
  "DIFFICULTY_MISMATCH",
  "WEAK_DISTRACTOR",
  "TOO_EASY_DISTRACTOR",
  "DISTRACTOR_QUALITY",
];

export interface GameValidationIssue {
  /** Zero-based index of the offending question; `-1` for a whole-game issue. */
  questionIndex: number;
  type: GameValidationIssueType;
  /**
   * Informational blocking severity, derived from `type` by the adapter for
   * logs/consumers. Application does NOT trust this field: it decides
   * blocking-ness purely from the code via `issueSeverity(type)`, so a hard type
   * can never be downgraded and a soft type can never be escalated. Optional so
   * hand-built issues (tests) may omit it.
   */
  severity?: "error" | "warning";
  /** Free text for logging/diagnostics only. Never drives control flow. */
  reason: string;
}

/** The reviewer's independent answer for one question. */
export interface IndependentQuestionReview {
  /** Zero-based, matches the draft question at this position. */
  questionIndex: number;
  /** The option the reviewer independently chose, or `null` when it could not decide. */
  answerIndex: number | null;
  confident: boolean;
  ambiguous: boolean;
  issues: GameValidationIssue[];
}

/**
 * The reviewer's independent output. It is NOT a verdict: it carries no `valid`
 * flag. `questions` has exactly one entry per draft question, index-aligned.
 * Application computes the verdict by comparing each `answerIndex` against the
 * generator's marked answer.
 */
export interface GameValidationResult {
  questions: IndependentQuestionReview[];
  /** Whole-game issues not tied to a single question. */
  issues: GameValidationIssue[];
}

/**
 * Raised for technical validator failures: provider unavailable, transport
 * error, unparseable or unexpected response, an incomplete set of question
 * results, or an out-of-range answer index. Distinct from a well-formed review
 * that merely disagrees with the generator. The pipeline fails closed on this
 * error and never persists.
 */
export class GameValidatorError extends Error {
  constructor(message = "AI game validator is unavailable.") {
    super(message);
    this.name = "GameValidatorError";
  }
}
