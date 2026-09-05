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
  type GeneratedGameDraft,
  type GenerateGameCommand,
  type GenerateGameRequest,
  type GameGenerator,
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

interface GenerateGameServiceOptions {
  enabled: boolean;
  createId?: () => string;
}

export class GenerateGameService {
  private readonly generator: GameGenerator;
  private readonly games: GameRepository;
  private readonly enabled: boolean;
  private readonly createId: () => string;

  constructor(
    generator: GameGenerator,
    games: GameRepository,
    options: GenerateGameServiceOptions,
  ) {
    this.generator = generator;
    this.games = games;
    this.enabled = options.enabled;
    this.createId = options.createId ?? randomUUID;
  }

  async generate(command: GenerateGameCommand): Promise<Game> {
    if (!this.enabled) {
      throw new ApplicationError("AI_GENERATION_DISABLED", "AI game generation is disabled.");
    }

    const normalizedCommand = validateCommand(command);
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
    const draft = await this.generateValidDraft(request);
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

  private async generateValidDraft(request: GenerateGameRequest): Promise<GeneratedGameDraft> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return validateAndNormalizeDraft(await this.generator.generate(request), request);
      } catch (error) {
        if (!(error instanceof InvalidGeneratedGameCandidateError)) {
          throw new ApplicationError("AI_GENERATION_FAILED", "AI game generation failed.");
        }
        if (attempt === 1) {
          throw new ApplicationError(
            "AI_GENERATED_CONTENT_INVALID",
            "AI generated content did not satisfy the game rules.",
          );
        }
      }
    }
    throw new ApplicationError("AI_GENERATED_CONTENT_INVALID", "AI generated content did not satisfy the game rules.");
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
  if (!value || typeof value !== "object") invalidCandidate();
  const draft = value as Partial<GeneratedGameDraft>;
  const title = requiredText(draft.title, 100);
  const category = normalizeCategory(draft.category);
  if (draft.difficulty !== request.difficulty || !Array.isArray(draft.questions) || draft.questions.length !== questionCount) {
    invalidCandidate();
  }

  const questionIds = new Set<string>();
  const questionTexts = new Set<string>();
  const questions = draft.questions.map((question) => normalizeQuestion(
    question,
    request.difficulty,
    category.id,
    questionIds,
    questionTexts,
  ));

  return { title, category, difficulty: request.difficulty, questions };
}

function normalizeCategory(value: unknown): Category {
  if (!value || typeof value !== "object") invalidCandidate();
  const category = value as Partial<Category>;
  return {
    id: requiredText(category.id, generatedFieldLimits.categoryId),
    name: requiredText(category.name, generatedFieldLimits.categoryName),
    description: requiredText(category.description, generatedFieldLimits.categoryDescription),
    icon: requiredText(category.icon, generatedFieldLimits.categoryIcon),
  };
}

function normalizeQuestion(
  value: unknown,
  difficulty: Difficulty,
  categoryId: string,
  questionIds: Set<string>,
  questionTexts: Set<string>,
): Question {
  if (!value || typeof value !== "object") invalidCandidate();
  const question = value as Partial<Question>;
  const id = uniqueText(question.id, questionIds, generatedFieldLimits.questionId);
  const text = uniqueText(question.text, questionTexts, 240);
  if (
    requiredText(question.categoryId) !== categoryId
    || question.difficulty !== difficulty
    || !Array.isArray(question.answers)
    || question.answers.length !== 4
  ) {
    invalidCandidate();
  }

  const answerIds = new Set<string>();
  const answerTexts = new Set<string>();
  const answers = question.answers.map((answer) => normalizeAnswer(answer, answerIds, answerTexts));
  if (answers.filter((answer) => answer.isCorrect).length !== 1) invalidCandidate();

  return {
    id,
    categoryId,
    difficulty,
    text,
    answers,
    ...normalizeOptionalMedia(question),
  };
}

function normalizeAnswer(
  value: unknown,
  answerIds: Set<string>,
  answerTexts: Set<string>,
): Answer {
  if (!value || typeof value !== "object") invalidCandidate();
  const answer = value as Partial<Answer>;
  if (typeof answer.isCorrect !== "boolean") invalidCandidate();
  return {
    id: uniqueText(answer.id, answerIds, generatedFieldLimits.answerId),
    text: uniqueText(answer.text, answerTexts, 120),
    isCorrect: answer.isCorrect,
  };
}

function normalizeOptionalMedia(question: Partial<Question>): Pick<Question, "emoji" | "image"> {
  const media: Pick<Question, "emoji" | "image"> = {};
  if (question.emoji !== undefined) media.emoji = requiredText(question.emoji, generatedFieldLimits.emoji);
  if (question.image !== undefined) media.image = requiredText(question.image, generatedFieldLimits.image);
  return media;
}

function requiredText(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string") invalidCandidate();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) invalidCandidate();
  return normalized;
}

function uniqueText(value: unknown, seen: Set<string>, maxLength?: number): string {
  const normalized = requiredText(value, maxLength);
  if (seen.has(normalized)) invalidCandidate();
  seen.add(normalized);
  return normalized;
}

function invalidCandidate(): never {
  throw new InvalidGeneratedGameCandidateError();
}
