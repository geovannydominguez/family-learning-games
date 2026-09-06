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
import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameCandidateFailure,
  type GeneratedGameDraft,
  type GenerateGameCommand,
  type GenerateGameRequest,
  type GameGenerator,
  type GenerationFailureType,
  type GenerationValidationRule,
} from "./GameGenerator.ts";

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
}

interface GenerateGameServiceOptions {
  enabled: boolean;
  createId?: () => string;
  logDiagnostic?: (diagnostic: GenerationFailureDiagnostic) => void;
}

export class GenerateGameService {
  private readonly generator: GameGenerator;
  private readonly games: GameRepository;
  private readonly enabled: boolean;
  private readonly createId: () => string;
  private readonly logDiagnostic: (diagnostic: GenerationFailureDiagnostic) => void;

  constructor(
    generator: GameGenerator,
    games: GameRepository,
    options: GenerateGameServiceOptions,
  ) {
    this.generator = generator;
    this.games = games;
    this.enabled = options.enabled;
    this.createId = options.createId ?? randomUUID;
    this.logDiagnostic = options.logDiagnostic ?? (() => {});
  }

  async generate(command: GenerateGameCommand): Promise<Game> {
    if (!this.enabled) {
      throw new ApplicationError("AI_GENERATION_DISABLED", "AI game generation is disabled.");
    }

    const normalizedCommand = validateCommand(command);
    const correlationId = safeCorrelationId(command.correlationId);
    const players = await this.games.getPlayers();
    const player = players.find(({ id }) => id === normalizedCommand.playerId);
    if (!player || !isValidAge(player.age)) {
      throw new ApplicationError("INVALID_GENERATION_REQUEST", "Generation request is invalid.");
    }
    const request: GenerateGameRequest = {
      topic: normalizedCommand.topic,
      difficulty: normalizedCommand.difficulty,
      questionCount: normalizedCommand.questionCount,
      targetAge: player.age,
    };
    const draft = await this.generateValidDraft(request, correlationId);
    const game: Game = {
      id: `ai-${this.createId()}`,
      title: draft.title,
      category: draft.category,
      players,
      questions: draft.questions,
    };

    await this.games.create(game);
    return game;
  }

  private async generateValidDraft(
    request: GenerateGameRequest,
    correlationId: string | undefined,
  ): Promise<GeneratedGameDraft> {
    const categoryId = toCategorySlug(request.topic);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const draft = await this.generator.generate(request);
        // Application owns the category identity: the provider must not choose
        // a durable identifier (see ADR-009). Fixing it here also removes the
        // "missing category.id" / "category_mismatch" failure classes without
        // touching validateAndNormalizeDraft.
        applyCategoryIdentity(draft, categoryId);
        return validateAndNormalizeDraft(draft, request);
      } catch (error) {
        const failure = classifyGenerationFailure(error);
        this.emitFailure(attempt, correlationId, failure);
        if (failure.failureType === "provider_error") {
          throw new ApplicationError("AI_GENERATION_FAILED", "AI game generation failed.");
        }
        if (attempt === 2) {
          throw new ApplicationError(
            "AI_GENERATED_CONTENT_INVALID",
            "AI generated content did not satisfy the game rules.",
          );
        }
      }
    }
    throw new ApplicationError("AI_GENERATED_CONTENT_INVALID", "AI generated content did not satisfy the game rules.");
  }

  private emitFailure(
    attempt: number,
    correlationId: string | undefined,
    failure: GeneratedGameCandidateFailure,
  ): void {
    this.logDiagnostic({
      event: "ai_generation_failure",
      level: "warn",
      ...(correlationId ? { correlationId } : {}),
      attempt,
      failureType: failure.failureType,
      ...(failure.validationRule ? { validationRule: failure.validationRule } : {}),
      ...(failure.validationField ? { validationField: failure.validationField } : {}),
      ...(failure.stopReason ? { stopReason: failure.stopReason } : {}),
    });
  }
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

function validateAndNormalizeDraft(
  value: GeneratedGameDraft,
  request: GenerateGameRequest,
): GeneratedGameDraft {
  if (!value || typeof value !== "object") invalidCandidate("missing_required_field");
  const draft = value as Partial<GeneratedGameDraft>;
  const title = requiredText(draft.title, "title", 100);
  const category = normalizeCategory(draft.category);
  if (draft.difficulty !== request.difficulty) invalidCandidate("difficulty_mismatch", "difficulty");
  if (!Array.isArray(draft.questions)) invalidCandidate("missing_required_field", "questions");
  if (draft.questions.length !== questionCount) invalidCandidate("question_count", "questions");

  const questionIds = new Set<string>();
  const questionTexts = new Set<string>();
  const questions = draft.questions.map((question, index) => normalizeQuestion(
    question,
    index,
    request.difficulty,
    category.id,
    questionIds,
    questionTexts,
  ));

  return { title, category, difficulty: request.difficulty, questions };
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

function normalizeQuestion(
  value: unknown,
  index: number,
  difficulty: Difficulty,
  categoryId: string,
  questionIds: Set<string>,
  questionTexts: Set<string>,
): Question {
  const field = `questions[${index}]`;
  if (!value || typeof value !== "object") invalidCandidate("missing_required_field", field);
  const question = value as Partial<Question>;
  const id = uniqueText(question.id, questionIds, "duplicate_question_id", `${field}.id`, generatedFieldLimits.questionId);
  const text = uniqueText(question.text, questionTexts, "duplicate_text", `${field}.text`, 240);
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
