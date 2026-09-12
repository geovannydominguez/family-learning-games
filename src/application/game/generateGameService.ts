import { randomUUID } from "node:crypto";

import type {
  Answer,
  Category,
  Difficulty,
  Game,
  Question,
} from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError } from "../errors.ts";
import type { PlayerRepository } from "../player/PlayerRepository.ts";
import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameCandidateFailure,
  type GeneratedGameDraft,
  type GenerateGameCommand,
  type GenerateGameRequest,
  type GameGenerator,
  type GenerationFailureType,
  type GenerationValidationRule,
  type PreviousGenerationIssue,
} from "./GameGenerator.ts";
import {
  GameValidatorError,
  issueSeverity,
  type GameValidationIssue,
  type GameValidationResult,
  type GameValidator,
} from "./GameValidator.ts";

const difficulties: readonly Difficulty[] = ["easy", "normal", "hard"];
const questionCount = 10;
const generatedFieldLimits = {
  categoryId: 80,
  categoryName: 100,
  categoryDescription: 300,
  categoryIcon: 16,
  questionId: 80,
  answerId: 80,
  emoji: 16,
  image: 2_048,
} as const;

const correlationIdPattern = /^[A-Za-z0-9._~=+/-]{1,128}$/;
/** A content-repair round is consumed only when generation yields evaluable candidates. */
const defaultRepairRounds = 5;
/** Bounded per-round retries for failures that produced no candidate content (guardrail, transport). */
const defaultTechnicalRetriesPerRound = 1;

/**
 * Coarse, provider-neutral lifecycle event for the two-model generation
 * pipeline. Carries counts and stable issue codes only, never prompts, model
 * output, question/answer text, or personal data.
 *
 * The pipeline is now question-level repair rounds, not whole-draft regeneration:
 * accepted questions are kept and only failed slots are re-requested.
 */
export interface GenerationPipelineEvent {
  event:
    | "AI_GAME_GENERATION_ATTEMPT"
    | "AI_GAME_REPAIR_ROUND"
    | "AI_GAME_VALIDATION_SUCCEEDED"
    | "AI_GAME_VALIDATION_REJECTED"
    | "AI_GAME_GENERATION_EXHAUSTED"
    | "AI_GAME_VALIDATION_ERROR"
    | "AI_GAME_GUARDRAIL_INTERVENED";
  level: "info" | "warn" | "error";
  correlationId?: string;
  /** Repair round (1-based). `attempt` mirrors it for backward compatibility. */
  attempt: number;
  round?: number;
  maxAttempts: number;
  /** 0 for the round's first generation attempt, 1.. for a same-round technical retry. */
  technicalRetry?: number;
  /**
   * `false` on `AI_GAME_GUARDRAIL_INTERVENED`: a Guardrail block is a deliberate,
   * deterministic policy decision, not a transient technical fault, so it is
   * never retried. Absent on events where retry semantics do not apply.
   */
  retryable?: boolean;
  /** Replacement questions asked for this round (10 on round 1, fewer afterwards). */
  requestedQuestionCount?: number;
  /** Total accepted questions in the pool. On success this is exactly 10. */
  acceptedQuestionCount?: number;
  /**
   * Size of the monotonically growing exclusion set for this operation — every
   * question text seen so far (accepted, semantically rejected, or generated and
   * later discarded). It is the count only; texts are never logged. Present on
   * `AI_GAME_GENERATION_ATTEMPT` and `AI_GAME_REPAIR_ROUND`.
   */
  seenQuestionCount?: number;
  /** AI_GAME_REPAIR_ROUND accounting (all per-round): */
  generatedCount?: number;
  acceptedCount?: number;
  rejectedQuestionCount?: number;
  issueCount?: number;
  missingCount?: number;
  questionCount?: number;
  issueTypes?: string[];
  /** Non-blocking quality observations; reported on AI_GAME_VALIDATION_SUCCEEDED. */
  warningCount?: number;
  warningTypes?: string[];
  /** Present on per-question AI_GAME_VALIDATION_REJECTED events (slot index within the round). */
  questionIndex?: number;
  generatorAnswerIndex?: number;
  validatorAnswerIndex?: number | null;
  confident?: boolean;
  ambiguous?: boolean;
  /** Present on AI_GAME_GUARDRAIL_INTERVENED. Content-free: policy/filter tokens only. */
  guardrailId?: string;
  guardrailVersion?: string;
  guardrailPolicies?: string[];
  guardrailFilterTypes?: string[];
  guardrailActions?: string[];
  guardrailStopReason?: string;
  generatorModel?: string;
  validatorModel?: string;
}

/**
 * Structured, provider-neutral record emitted once per failed generation
 * attempt so that a `422 AI_GENERATED_CONTENT_INVALID` (or `502`) can be
 * diagnosed from logs. It intentionally excludes prompts, raw model output,
 * question/answer content, field values, the topic, the target age, and any
 * personal data. `validationField` is a structural path only.
 */
export interface GenerationFailureDiagnostic {
  event: "ai_generation_failure";
  level: "warn";
  correlationId?: string;
  attempt: number;
  failureType: GenerationFailureType;
  validationRule?: GenerationValidationRule;
  validationField?: string;
  stopReason?: string;
  /** 1.. when this failure happened on a same-round technical retry. */
  technicalRetry?: number;
  /** For `guardrail_intervened` / `content_filtered`: which rule fired. Content-free. */
  guardrailPolicies?: string[];
  guardrailFilterTypes?: string[];
  guardrailActions?: string[];
}

interface GenerateGameServiceOptions {
  enabled: boolean;
  createId?: () => string;
  logDiagnostic?: (diagnostic: GenerationFailureDiagnostic) => void;
  logEvent?: (event: GenerationPipelineEvent) => void;
  /** Max question-level content-repair rounds before failing. Defaults to 5. */
  maxRepairRounds?: number;
  /** @deprecated alias for `maxRepairRounds`, kept for backward compatibility. */
  maxAttempts?: number;
  /** Same-round retries for no-content failures (guardrail, transport). Defaults to 1. */
  maxTechnicalRetriesPerRound?: number;
  /** Opaque model labels, for observability only. */
  models?: { generator?: string; validator?: string };
}

export class GenerateGameService {
  private readonly generator: GameGenerator;
  private readonly validator: GameValidator;
  private readonly games: GameRepository;
  private readonly players: PlayerRepository;
  private readonly enabled: boolean;
  private readonly createId: () => string;
  private readonly logDiagnostic: (diagnostic: GenerationFailureDiagnostic) => void;
  private readonly logEvent: (event: GenerationPipelineEvent) => void;
  private readonly maxRepairRounds: number;
  private readonly maxTechnicalRetriesPerRound: number;
  private readonly models: { generator?: string; validator?: string };

  constructor(
    generator: GameGenerator,
    validator: GameValidator,
    games: GameRepository,
    players: PlayerRepository,
    options: GenerateGameServiceOptions,
  ) {
    this.generator = generator;
    this.validator = validator;
    this.games = games;
    this.players = players;
    this.enabled = options.enabled;
    this.createId = options.createId ?? randomUUID;
    this.logDiagnostic = options.logDiagnostic ?? (() => {});
    this.logEvent = options.logEvent ?? (() => {});
    this.maxRepairRounds = positiveRounds(options.maxRepairRounds)
      ?? positiveRounds(options.maxAttempts)
      ?? defaultRepairRounds;
    this.maxTechnicalRetriesPerRound = nonNegativeInt(options.maxTechnicalRetriesPerRound)
      ?? defaultTechnicalRetriesPerRound;
    this.models = options.models ?? {};
  }

  async generate(command: GenerateGameCommand): Promise<Game> {
    if (!this.enabled) {
      throw new ApplicationError("AI_GENERATION_DISABLED", "AI game generation is disabled.");
    }

    const normalizedCommand = validateCommand(command);
    const correlationId = safeCorrelationId(command.correlationId);
    // ADR-013: only `targetAge` crosses into `GenerateGameRequest` / the AI
    // boundary. The player's identity (playerId, name) is resolved here, in
    // Application, and never forwarded to `GameGenerator`/`GameValidator`.
    const player = await this.players.getById(normalizedCommand.playerId);
    if (!player || !isValidAge(player.age)) {
      throw new ApplicationError("INVALID_GENERATION_REQUEST", "Generation request is invalid.");
    }
    const request: GenerateGameRequest = {
      topic: normalizedCommand.topic,
      difficulty: normalizedCommand.difficulty,
      questionCount: normalizedCommand.questionCount,
      targetAge: player.age,
    };
    // Never persist before every question has passed every required validation.
    const built = await this.assembleValidatedGame(request, correlationId);
    const game: Game = {
      id: `ai-${this.createId()}`,
      title: built.title,
      category: built.category,
      // The legacy static player roster is no longer the source of "who is
      // playing" (see GameSessionService); this field is not consulted for
      // AI-generated games (`getPlayers()` already excludes them).
      players: [],
      questions: built.questions,
      generationMetadata: { targetAge: request.targetAge, difficulty: normalizedCommand.difficulty },
    };

    await this.games.create(game);
    return game;
  }

  /**
   * Question-level repair pipeline. Valid questions are kept in an accepted
   * pool; only failed slots are re-requested. Each round:
   *   Nova Micro generates `missingCount` candidates
   *     → per-question structural validation  (valid ones survive)
   *     → uniqueness check against the accepted pool
   *     → Nova Pro blind independent validation of the survivors
   *     → per-question deterministic comparison (valid ones join the pool)
   * The game is assembled and returned only when exactly 10 questions are
   * accepted. Technical failures of either model fail closed (never persist).
   */
  private async assembleValidatedGame(
    request: GenerateGameRequest,
    correlationId: string | undefined,
  ): Promise<{ title: string; category: Category; questions: Question[] }> {
    const categoryId = toCategorySlug(request.topic);
    const accepted: Question[] = [];
    // Exclusion context for the generator: every question text seen this
    // operation — accepted, rejected by Nova Pro, or generated in an earlier
    // round and discarded. Keyed by a normalized comparison key; the value is the
    // first original text, which is what the generator is shown so it phrases
    // replacements naturally. It grows monotonically across repair rounds and is
    // never cleared. It is NOT the deterministic duplicate guard — see
    // `acceptedKeys` — and `accepted` stays the ONLY source of the final game.
    const seen = new Map<string, string>();
    // Deterministic `duplicate_text` guard: normalized keys of questions already
    // in the accepted pool. Unchanged responsibility, only the key is normalized.
    const acceptedKeys = new Set<string>();
    const warningTypes = new Set<string>();
    let meta: { title: string; category: Category } | undefined;
    let previousIssues: readonly PreviousGenerationIssue[] = [];
    let round = 0;

    for (round = 1; round <= this.maxRepairRounds; round += 1) {
      const missingCount = questionCount - accepted.length;
      const genRequest: GenerateGameRequest = {
        topic: request.topic,
        difficulty: request.difficulty,
        targetAge: request.targetAge,
        questionCount: missingCount,
        ...(seen.size > 0 ? { existingQuestions: [...seen.values()] } : {}),
        ...(previousIssues.length > 0 ? { previousIssues } : {}),
      };

      // 1) Generate replacement candidates. Failures are classified into three
      //    disjoint kinds, each with its own recovery:
      //      - TRANSIENT technical fault (transport/throttling/5xx `provider_error`)
      //        or MALFORMED output (`invalid_json` / `invalid_shape`): a failure
      //        that produced no candidate content gets ONE bounded same-round
      //        technical retry; `provider_error` then fails closed, malformed
      //        output just consumes the round.
      //      - GUARDRAIL INTERVENTION (`guardrail_intervened` / `content_filtered`):
      //        a deterministic policy decision driven by the request itself, not a
      //        transient fault. Retrying the identical `temperature: 0` call — and
      //        every further repair round — would be blocked the same way, so it
      //        is recorded once and finalizes the whole operation immediately
      //        instead of burning retries and rounds until the Lambda times out.
      let raw: unknown;
      for (let technicalRetry = 0; ; technicalRetry += 1) {
        this.emitEvent({
          event: "AI_GAME_GENERATION_ATTEMPT",
          level: "info",
          correlationId,
          attempt: round,
          round,
          technicalRetry,
          requestedQuestionCount: missingCount,
          acceptedQuestionCount: accepted.length,
          seenQuestionCount: seen.size,
        });
        try {
          raw = await this.generator.generate(genRequest);
          applyCategoryIdentity(raw as GeneratedGameDraft, categoryId);
          break;
        } catch (error) {
          const failure = classifyGenerationFailure(error);
          this.emitFailure(round, correlationId, failure, technicalRetry);
          if (failure.failureType === "guardrail_intervened" || failure.failureType === "content_filtered") {
            // Guardrail intervention: no technical retry, no further repair round.
            this.emitGuardrail(correlationId, round, missingCount, failure, technicalRetry);
            throw new ApplicationError(
              "AI_GENERATION_BLOCKED",
              "AI game generation was blocked by content safety rules.",
            );
          }
          const noContentFailure = failure.failureType === "provider_error"
            || failure.failureType === "invalid_json"
            || failure.failureType === "invalid_shape";
          if (noContentFailure && technicalRetry < this.maxTechnicalRetriesPerRound) {
            continue; // retry the SAME repair round
          }
          if (failure.failureType === "provider_error") {
            // Transport error that also failed its retry: fail closed.
            throw new ApplicationError("AI_GENERATION_FAILED", "AI game generation failed.");
          }
          // Malformed response persisted past the technical retry: this round
          // yields no questions and is consumed (the loop stays bounded).
          raw = undefined;
          break;
        }
      }

      // 1b) Defense in depth against an adapter that ignores the batch size.
      //     The port contract is: a call for `missingCount` returns exactly
      //     `missingCount` questions. A response of any other length (e.g. a
      //     fixed batch of 10 for a 1-question repair) is rejected whole — never
      //     silently trimmed — and the round is consumed. The real returned size
      //     is still logged so the mismatch is visible in CloudWatch.
      let unexpectedBatchCount: number | undefined;
      if (raw !== undefined) {
        const returnedCount = readQuestionsArray(raw).length;
        if (returnedCount !== missingCount) {
          unexpectedBatchCount = returnedCount;
          this.emitFailure(round, correlationId, {
            failureType: "validation_failed",
            validationRule: "unexpected_question_count",
          });
          this.emitRejected(correlationId, round, { issueTypes: ["unexpected_question_count"] });
          raw = undefined;
        }
      }

      if (raw && !meta) meta = tryCaptureGameMeta(raw, request.difficulty);

      // 2) Per-question structural validation + pool uniqueness.
      const roundStructuralIssues: string[] = [];
      const roundSemanticIssues: string[] = [];
      const candidates: Question[] = [];
      const candidateKeys: string[] = [];
      const roundTexts = new Set<string>();
      let generatedCount = 0;
      let structuralRejectedCount = 0;
      for (const rawQuestion of readQuestionsArray(raw)) {
        if (candidates.length >= missingCount) break;
        generatedCount += 1;
        let question: Question;
        try {
          question = normalizeQuestionShape(rawQuestion, candidates.length, request.difficulty, categoryId);
        } catch (error) {
          const rule = structuralRuleOf(error);
          roundStructuralIssues.push(rule);
          structuralRejectedCount += 1;
          this.emitFailure(round, correlationId, classifyGenerationFailure(error));
          this.emitRejected(correlationId, round, { issueTypes: [rule] });
          continue;
        }
        const dedupKey = questionDedupKey(question.text);
        // Deterministic guard: reject a candidate that repeats an already-accepted
        // question or another candidate from the same round. Normalized so trivial
        // case/accent/punctuation variants collide too.
        if (acceptedKeys.has(dedupKey) || roundTexts.has(dedupKey)) {
          roundStructuralIssues.push("duplicate_text");
          structuralRejectedCount += 1;
          this.emitFailure(round, correlationId, {
            failureType: "validation_failed",
            validationRule: "duplicate_text",
            validationField: `questions[${candidates.length}].text`,
          });
          this.emitRejected(correlationId, round, { issueTypes: ["duplicate_text"] });
          continue;
        }
        roundTexts.add(dedupKey);
        // Record every structurally-valid candidate as "seen" now, before Nova Pro
        // reviews it: even if it is rejected next, the generator must be told not
        // to produce it again in a later repair round.
        seen.set(dedupKey, question.text);
        candidateKeys.push(dedupKey);
        candidates.push(question);
      }

      // 3) Nova Pro blind independent validation of the structurally-valid candidates.
      let acceptedThisRound = 0;
      let semanticRejectedCount = 0;
      let semanticIssueCount = 0;
      if (candidates.length > 0) {
        let review: GameValidationResult;
        try {
          review = await this.validator.validate({
            topic: request.topic,
            difficulty: request.difficulty,
            targetAge: request.targetAge,
            draft: {
              title: meta?.title ?? request.topic,
              difficulty: request.difficulty,
              category: meta?.category ?? { id: categoryId, name: request.topic, description: request.topic, icon: "❓" },
              questions: candidates,
            },
          });
        } catch (error) {
          this.emitEvent({
            event: "AI_GAME_VALIDATION_ERROR",
            level: "error",
            correlationId,
            attempt: round,
            round,
            questionCount: candidates.length,
          });
          if (error instanceof GameValidatorError) {
            throw new ApplicationError("AI_GENERATION_FAILED", "AI game validation failed.");
          }
          throw error;
        }

        const verdict = evaluateReview(candidates, review);
        verdict.warningTypes.forEach((type) => warningTypes.add(type));
        candidates.forEach((question, slot) => {
          const failure = verdict.failures.find((entry) => entry.questionIndex === slot);
          if (!failure) {
            // Already in `seen`; also register it in the deterministic duplicate
            // guard. `accepted` is what becomes the final game.
            accepted.push(question);
            acceptedKeys.add(candidateKeys[slot]);
            acceptedThisRound += 1;
            return;
          }
          semanticRejectedCount += 1;
          semanticIssueCount += failure.issueTypes.length;
          roundSemanticIssues.push(...failure.issueTypes);
          this.emitRejected(correlationId, round, {
            questionIndex: slot,
            issueTypes: failure.issueTypes,
            generatorAnswerIndex: failure.generatorAnswerIndex,
            validatorAnswerIndex: failure.validatorAnswerIndex,
            confident: failure.confident,
            ambiguous: failure.ambiguous,
          });
        });
      }

      // Distinct counters: `rejectedQuestionCount` counts QUESTIONS not issues;
      // one rejected question can carry several issues, so issueCount >= it.
      const rejectedQuestionCount = structuralRejectedCount + semanticRejectedCount;
      const issueCount = roundStructuralIssues.length + semanticIssueCount;
      this.emitEvent({
        event: "AI_GAME_REPAIR_ROUND",
        level: "info",
        correlationId,
        attempt: round,
        round,
        requestedQuestionCount: missingCount,
        generatedCount: unexpectedBatchCount ?? generatedCount,
        acceptedCount: acceptedThisRound,
        rejectedQuestionCount,
        issueCount,
        acceptedQuestionCount: accepted.length,
        seenQuestionCount: seen.size,
        missingCount: Math.max(0, questionCount - accepted.length),
      });

      if (accepted.length >= questionCount && meta) break;

      previousIssues = [...roundStructuralIssues, ...roundSemanticIssues]
        .slice(0, 10)
        .map((type, index) => ({ questionIndex: index, type, reason: type }));
    }

    if (accepted.length < questionCount || !meta) {
      const exhaustedRound = Math.min(round, this.maxRepairRounds);
      this.emitEvent({
        event: "AI_GAME_GENERATION_EXHAUSTED",
        level: "warn",
        correlationId,
        attempt: exhaustedRound,
        round: exhaustedRound,
        acceptedQuestionCount: accepted.length,
        missingCount: Math.max(0, questionCount - accepted.length),
      });
      throw new ApplicationError("AI_GENERATED_CONTENT_INVALID", "AI generated content did not pass validation.");
    }

    const questions = accepted.slice(0, questionCount).map((question, index) => reindexQuestion(question, index));
    this.emitEvent({
      event: "AI_GAME_VALIDATION_SUCCEEDED",
      level: "info",
      correlationId,
      attempt: round,
      round,
      questionCount,
      acceptedQuestionCount: questionCount,
      ...(warningTypes.size > 0 ? { warningCount: warningTypes.size, warningTypes: [...warningTypes] } : {}),
    });
    return { title: meta.title, category: meta.category, questions };
  }

  private emitEvent(event: Omit<GenerationPipelineEvent, "maxAttempts" | "generatorModel" | "validatorModel">): void {
    this.logEvent({
      ...event,
      maxAttempts: this.maxRepairRounds,
      ...(this.models.generator ? { generatorModel: this.models.generator } : {}),
      ...(this.models.validator ? { validatorModel: this.models.validator } : {}),
    });
  }

  private emitRejected(
    correlationId: string | undefined,
    round: number,
    detail: {
      questionIndex?: number;
      issueTypes: string[];
      generatorAnswerIndex?: number;
      validatorAnswerIndex?: number | null;
      confident?: boolean;
      ambiguous?: boolean;
    },
  ): void {
    this.emitEvent({
      event: "AI_GAME_VALIDATION_REJECTED",
      level: "warn",
      correlationId,
      attempt: round,
      round,
      issueCount: 1,
      ...detail,
    });
  }

  private emitFailure(
    attempt: number,
    correlationId: string | undefined,
    failure: GeneratedGameCandidateFailure,
    technicalRetry = 0,
  ): void {
    const guardrail = summarizeGuardrail(failure.guardrail);
    this.logDiagnostic({
      event: "ai_generation_failure",
      level: "warn",
      ...(correlationId ? { correlationId } : {}),
      attempt,
      ...(technicalRetry > 0 ? { technicalRetry } : {}),
      failureType: failure.failureType,
      ...(failure.validationRule ? { validationRule: failure.validationRule } : {}),
      ...(failure.validationField ? { validationField: failure.validationField } : {}),
      ...(failure.stopReason ? { stopReason: failure.stopReason } : {}),
      ...(guardrail.policies.length > 0 ? { guardrailPolicies: guardrail.policies } : {}),
      ...(guardrail.filterTypes.length > 0 ? { guardrailFilterTypes: guardrail.filterTypes } : {}),
      ...(guardrail.actions.length > 0 ? { guardrailActions: guardrail.actions } : {}),
    });
  }

  private emitGuardrail(
    correlationId: string | undefined,
    round: number,
    requestedQuestionCount: number,
    failure: GeneratedGameCandidateFailure,
    technicalRetry: number,
  ): void {
    const guardrail = summarizeGuardrail(failure.guardrail);
    this.emitEvent({
      event: "AI_GAME_GUARDRAIL_INTERVENED",
      level: "warn",
      correlationId,
      attempt: round,
      round,
      technicalRetry,
      retryable: false,
      requestedQuestionCount,
      ...(failure.stopReason ? { guardrailStopReason: failure.stopReason } : {}),
      ...(failure.guardrail?.guardrailId ? { guardrailId: failure.guardrail.guardrailId } : {}),
      ...(failure.guardrail?.guardrailVersion ? { guardrailVersion: failure.guardrail.guardrailVersion } : {}),
      ...(guardrail.policies.length > 0 ? { guardrailPolicies: guardrail.policies } : {}),
      ...(guardrail.filterTypes.length > 0 ? { guardrailFilterTypes: guardrail.filterTypes } : {}),
      ...(guardrail.actions.length > 0 ? { guardrailActions: guardrail.actions } : {}),
    });
  }
}

function summarizeGuardrail(
  guardrail: GeneratedGameCandidateFailure["guardrail"],
): { policies: string[]; filterTypes: string[]; actions: string[] } {
  const assessments = guardrail?.assessments ?? [];
  return {
    policies: [...new Set(assessments.map((entry) => entry.policy))],
    filterTypes: [...new Set(assessments.map((entry) => entry.type))],
    actions: [...new Set(assessments.map((entry) => entry.action))],
  };
}

interface QuestionReviewFailure {
  questionIndex: number;
  generatorAnswerIndex: number;
  validatorAnswerIndex: number | null;
  confident: boolean;
  ambiguous: boolean;
  issueTypes: string[];
  reason: string;
}

interface ReviewVerdict {
  valid: boolean;
  failures: QuestionReviewFailure[];
  gameIssueTypes: string[];
  /** Non-blocking quality observations. Do not affect `valid`. */
  warningTypes: string[];
}

/** Blocking severity is decided by the issue CODE, never by the model's own claim. */
function isBlocking(issue: GameValidationIssue): boolean {
  return issueSeverity(issue.type) === "error";
}

/**
 * The deterministic per-candidate verdict. For each candidate the reviewer's
 * INDEPENDENT answer must exist, be confident, non-ambiguous, free of
 * ERROR-severity issues, and equal to the answer the generator marked correct.
 * WARNING-severity issues (weak/easy distractors, difficulty feel) never
 * invalidate a question. `failures[].questionIndex` is the candidate's slot.
 */
function evaluateReview(candidates: readonly Question[], review: GameValidationResult): ReviewVerdict {
  const reviewByIndex = new Map(review.questions.map((question) => [question.questionIndex, question]));
  const failures: QuestionReviewFailure[] = [];
  const warningTypes = new Set<string>();

  candidates.forEach((question, index) => {
    const generatorAnswerIndex = question.answers.findIndex((answer) => answer.isCorrect);
    const result = reviewByIndex.get(index);
    if (!result) {
      failures.push({
        questionIndex: index,
        generatorAnswerIndex,
        validatorAnswerIndex: null,
        confident: false,
        ambiguous: false,
        issueTypes: ["FACTUAL_UNCERTAINTY"],
        reason: "the reviewer returned no result for this question",
      });
      return;
    }

    for (const issue of result.issues) {
      if (!isBlocking(issue)) warningTypes.add(issue.type);
    }
    const blockingIssueTypes = result.issues
      .filter((issue) => isBlocking(issue))
      .map((issue) => issue.type);

    const answerIndex = result.answerIndex;
    const inRange = answerIndex !== null && answerIndex >= 0 && answerIndex < question.answers.length;
    const matches = inRange && answerIndex === generatorAnswerIndex;
    const questionValid = result.confident === true
      && result.ambiguous === false
      && answerIndex !== null
      && inRange
      && matches
      && blockingIssueTypes.length === 0;
    if (questionValid) return;

    const issueTypes = [...new Set<string>([
      ...blockingIssueTypes,
      ...(answerIndex === null ? ["FACTUAL_UNCERTAINTY"] : []),
      ...(!result.confident ? ["FACTUAL_UNCERTAINTY"] : []),
      ...(result.ambiguous ? ["AMBIGUOUS_QUESTION"] : []),
      ...(answerIndex !== null && !inRange ? ["INVALID_OPTIONS"] : []),
      ...(answerIndex !== null && inRange && !matches ? ["ANSWER_MISMATCH"] : []),
    ])];
    failures.push({
      questionIndex: index,
      generatorAnswerIndex,
      validatorAnswerIndex: answerIndex,
      confident: result.confident,
      ambiguous: result.ambiguous,
      issueTypes: issueTypes.length > 0 ? issueTypes : ["FACTUAL_UNCERTAINTY"],
      reason: issueTypes.join(", ") || "reviewer rejected this question",
    });
  });

  for (const issue of review.issues) {
    if (!isBlocking(issue)) warningTypes.add(issue.type);
  }
  const gameIssueTypes = [...new Set(
    review.issues.filter((issue) => isBlocking(issue)).map((issue) => issue.type),
  )];

  return {
    valid: failures.length === 0 && gameIssueTypes.length === 0,
    failures,
    gameIssueTypes,
    warningTypes: [...warningTypes],
  };
}

function classifyGenerationFailure(error: unknown): GeneratedGameCandidateFailure {
  if (error instanceof InvalidGeneratedGameCandidateError) {
    return error.failure;
  }
  // Any other error is a technical provider/transport fault. The original
  // error is discarded here so no provider detail can reach a diagnostic.
  return { failureType: "provider_error" };
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && correlationIdPattern.test(value) ? value : undefined;
}

/**
 * Normalized comparison key for cross-round de-duplication of question text.
 * Deterministic and dependency-free: it only folds away trivial differences
 * (case, accents, surrounding quotes/punctuation, repeated inner whitespace) so
 * that "¿Quién ganó el Mundial 2010?" and "Quien gano el mundial 2010" collide.
 * It is NEVER the stored question text — questions keep their original wording.
 */
function questionDedupKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'¿¡().,;:!?-]+/, "")
    .replace(/[\s"'¿¡().,;:!?-]+$/, "")
    .trim();
}

/**
 * Derives a stable, machine-only category identifier from the requested topic.
 * The provider never chooses this value. Always returns a non-empty, lowercase
 * ASCII slug of at most 80 characters.
 */
function toCategorySlug(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallbackCategorySlug(topic);
}

/** Deterministic, non-empty slug for topics that carry no ASCII-usable characters. */
function fallbackCategorySlug(topic: string): string {
  let hash = 0;
  for (let index = 0; index < topic.length; index += 1) {
    hash = (hash * 31 + topic.charCodeAt(index)) >>> 0;
  }
  return `tema-${hash.toString(36)}`;
}

/**
 * Overwrites the draft's category identifier and every question's `categoryId`
 * with the Application-owned slug, in place, before validation. Leaves a
 * missing/malformed `category` object untouched so the validator still rejects it.
 */
function applyCategoryIdentity(draft: GeneratedGameDraft, categoryId: string): void {
  const loose = draft as { category?: unknown; questions?: unknown };
  if (loose.category && typeof loose.category === "object") {
    (loose.category as { id?: string }).id = categoryId;
  }
  if (Array.isArray(loose.questions)) {
    for (const question of loose.questions) {
      if (question && typeof question === "object") {
        (question as { categoryId?: string }).categoryId = categoryId;
      }
    }
  }
}

function validateCommand(command: GenerateGameCommand): GenerateGameCommand {
  const topic = typeof command.topic === "string" ? command.topic.trim() : "";
  if (
    topic.length === 0
    || topic.length > 80
    || !difficulties.includes(command.difficulty)
    || command.questionCount !== questionCount
    || typeof command.playerId !== "string"
    || command.playerId.trim().length === 0
  ) {
    throw new ApplicationError("INVALID_GENERATION_REQUEST", "Generation request is invalid.");
  }
  return {
    topic,
    difficulty: command.difficulty,
    questionCount,
    playerId: command.playerId.trim(),
  };
}

function isValidAge(age: unknown): age is number {
  return typeof age === "number" && Number.isInteger(age) && age > 0;
}

function positiveRounds(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/** The draft-level metadata, or `undefined` when the response cannot supply it yet. */
function tryCaptureGameMeta(
  raw: unknown,
  difficulty: Difficulty,
): { title: string; category: Category } | undefined {
  try {
    const loose = raw as { title?: unknown; category?: unknown; difficulty?: unknown };
    if (loose.difficulty !== undefined && loose.difficulty !== difficulty) return undefined;
    return { title: requiredText(loose.title, "title", 100), category: normalizeCategory(loose.category) };
  } catch {
    return undefined;
  }
}

/** The raw question list, or `[]` for a response that cannot be mapped into questions. */
function readQuestionsArray(raw: unknown): unknown[] {
  const loose = raw as { questions?: unknown } | undefined;
  return loose && Array.isArray(loose.questions) ? loose.questions : [];
}

function structuralRuleOf(error: unknown): string {
  return error instanceof InvalidGeneratedGameCandidateError
    ? (error.failure.validationRule ?? "malformed_question")
    : "malformed_question";
}

/** Application owns question/answer identity; reassign stable ids to the final set. */
function reindexQuestion(question: Question, index: number): Question {
  const id = `q${index + 1}`;
  return {
    ...question,
    id,
    answers: question.answers.map((answer, answerIndex) => ({ ...answer, id: `${id}a${answerIndex + 1}` })),
  };
}

function normalizeCategory(value: unknown): Category {
  if (!value || typeof value !== "object") invalidCandidate("missing_required_field", "category");
  const category = value as Partial<Category>;
  return {
    id: requiredText(category.id, "category.id", generatedFieldLimits.categoryId),
    name: requiredText(category.name, "category.name", generatedFieldLimits.categoryName),
    description: requiredText(category.description, "category.description", generatedFieldLimits.categoryDescription),
    icon: requiredText(category.icon, "category.icon", generatedFieldLimits.categoryIcon),
  };
}

/**
 * Per-question structural validation. Throws `InvalidGeneratedGameCandidateError`
 * for THIS question only (malformed shape, wrong option count, no/many correct
 * answers, duplicate answer text, over-length fields, wrong difficulty/category).
 * Cross-question / cross-round uniqueness of question text is enforced by the
 * caller against the accepted pool; question and answer ids are reassigned by
 * Application on final assembly, so id collisions across rounds are irrelevant.
 */
function normalizeQuestionShape(
  value: unknown,
  index: number,
  difficulty: Difficulty,
  categoryId: string,
): Question {
  const field = `questions[${index}]`;
  if (!value || typeof value !== "object") invalidCandidate("missing_required_field", field);
  const question = value as Partial<Question>;
  const id = requiredText(question.id, `${field}.id`, generatedFieldLimits.questionId);
  const text = requiredText(question.text, `${field}.text`, 240);
  if (requiredText(question.categoryId, `${field}.categoryId`) !== categoryId) {
    invalidCandidate("category_mismatch", `${field}.categoryId`);
  }
  if (question.difficulty !== difficulty) invalidCandidate("difficulty_mismatch", `${field}.difficulty`);
  if (!Array.isArray(question.answers)) invalidCandidate("missing_required_field", `${field}.answers`);
  if (question.answers.length !== 4) invalidCandidate("answer_count", `${field}.answers`);

  const answerIds = new Set<string>();
  const answerTexts = new Set<string>();
  const answers = question.answers.map((answer, answerIndex) => normalizeAnswer(
    answer,
    `${field}.answers[${answerIndex}]`,
    answerIds,
    answerTexts,
  ));
  if (answers.filter((answer) => answer.isCorrect).length !== 1) {
    invalidCandidate("correct_answer_count", `${field}.answers`);
  }

  return {
    id,
    categoryId,
    difficulty,
    text,
    answers,
    ...normalizeOptionalMedia(question, field),
  };
}

function normalizeAnswer(
  value: unknown,
  field: string,
  answerIds: Set<string>,
  answerTexts: Set<string>,
): Answer {
  if (!value || typeof value !== "object") invalidCandidate("missing_required_field", field);
  const answer = value as Partial<Answer>;
  if (typeof answer.isCorrect !== "boolean") invalidCandidate("missing_required_field", `${field}.isCorrect`);
  return {
    id: uniqueText(answer.id, answerIds, "duplicate_answer_id", `${field}.id`, generatedFieldLimits.answerId),
    text: uniqueText(answer.text, answerTexts, "duplicate_text", `${field}.text`, 120),
    isCorrect: answer.isCorrect,
  };
}

function normalizeOptionalMedia(question: Partial<Question>, field: string): Pick<Question, "emoji" | "image"> {
  const media: Pick<Question, "emoji" | "image"> = {};
  if (question.emoji !== undefined) media.emoji = requiredText(question.emoji, `${field}.emoji`, generatedFieldLimits.emoji);
  if (question.image !== undefined) media.image = requiredText(question.image, `${field}.image`, generatedFieldLimits.image);
  return media;
}

function requiredText(value: unknown, field: string, maxLength = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string") invalidCandidate("missing_required_field", field);
  const normalized = value.trim();
  if (normalized.length === 0) invalidCandidate("missing_required_field", field);
  if (normalized.length > maxLength) invalidCandidate("field_length", field);
  return normalized;
}

function uniqueText(
  value: unknown,
  seen: Set<string>,
  duplicateRule: GenerationValidationRule,
  field: string,
  maxLength?: number,
): string {
  const normalized = requiredText(value, field, maxLength);
  if (seen.has(normalized)) invalidCandidate(duplicateRule, field);
  seen.add(normalized);
  return normalized;
}

function invalidCandidate(validationRule?: GenerationValidationRule, validationField?: string): never {
  throw new InvalidGeneratedGameCandidateError({
    failureType: "validation_failed",
    validationRule,
    validationField,
  });
}
