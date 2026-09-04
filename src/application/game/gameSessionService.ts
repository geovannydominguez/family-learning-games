import { randomUUID } from "node:crypto";

import type { Difficulty, GameSession } from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError } from "../errors.ts";
import type { GameSessionRepository } from "./GameSessionRepository.ts";
import { advanceSession, createGameSession, submitAnswer } from "./gameSession.ts";
import type {
  PublicGameSession,
  StartGameSessionCommand,
  SubmitAnswerResponse,
} from "./gameSessionContracts.ts";

const difficulties: readonly Difficulty[] = ["easy", "normal", "hard"];

export class GameSessionService {
  private readonly games: GameRepository;
  private readonly sessions: GameSessionRepository;
  private readonly createId: () => string;
  private readonly random: () => number;

  constructor(
    games: GameRepository,
    sessions: GameSessionRepository,
    createId: () => string = randomUUID,
    random: () => number = Math.random,
  ) {
    this.games = games;
    this.sessions = sessions;
    this.createId = createId;
    this.random = random;
  }

  async start(command: StartGameSessionCommand): Promise<PublicGameSession> {
    if (!command.playerId || !command.categoryId || !difficulties.includes(command.difficulty)) {
      throw new ApplicationError("INVALID_REQUEST", "Player, category and difficulty are required.");
    }

    const game = await this.games.findById(command.categoryId);
    const player = game?.players.find((candidate) => candidate.id === command.playerId);
    if (!game || !player) {
      throw new ApplicationError("RESOURCE_NOT_FOUND", "Player or category was not found.");
    }
    const category = game.category;
    const questions = game.questions.filter((question) => question.difficulty === command.difficulty);

    let session: GameSession;
    try {
      session = createGameSession({ player, category, difficulty: command.difficulty, questions, random: this.random });
    } catch {
      throw new ApplicationError("INVALID_SESSION_STATE", "There is not enough content to start this game.");
    }
    const id = this.createId();
    await this.sessions.create(id, session);
    return toPublicSession(id, session);
  }

  async answer(sessionId: string, answerId: string): Promise<SubmitAnswerResponse> {
    if (!answerId) throw new ApplicationError("INVALID_REQUEST", "Answer is required.");
    const session = await this.sessions.findById(sessionId);
    if (!session) throw new ApplicationError("SESSION_NOT_FOUND", "Game session was not found or has expired.");
    if (session.status !== "playing" || session.selectedAnswerId !== null) {
      throw new ApplicationError("INVALID_SESSION_STATE", "The game session cannot accept this answer.");
    }
    const question = session.questions[session.currentQuestionIndex];
    const answer = question?.answers.find((candidate) => candidate.id === answerId);
    if (!question || !answer) throw new ApplicationError("INVALID_REQUEST", "Answer does not belong to the current question.");
    const correctAnswer = question.answers.find((candidate) => candidate.isCorrect);
    if (!correctAnswer) throw new ApplicationError("INVALID_SESSION_STATE", "The current question is invalid.");

    const expectedRevision = session.revision;
    const nextSession = { ...advanceSession(submitAnswer(session, answerId)), revision: expectedRevision + 1 };
    await this.sessions.update(sessionId, nextSession, expectedRevision);
    return {
      feedback: {
        selectedAnswerId: answer.id,
        correctAnswerId: correctAnswer.id,
        correctAnswerText: correctAnswer.text,
        isCorrect: answer.isCorrect,
      },
      nextSession: toPublicSession(sessionId, nextSession),
    };
  }

  async get(sessionId: string): Promise<PublicGameSession> {
    const session = await this.sessions.findById(sessionId);
    if (!session) throw new ApplicationError("SESSION_NOT_FOUND", "Game session was not found or has expired.");
    return toPublicSession(sessionId, session);
  }
}

export function toPublicSession(id: string, session: GameSession): PublicGameSession {
  const question = session.status === "playing" ? session.questions[session.currentQuestionIndex] : undefined;
  return {
    id,
    player: session.player,
    category: session.category,
    difficulty: session.difficulty,
    currentQuestionIndex: session.currentQuestionIndex,
    totalQuestions: session.questions.length,
    score: session.score,
    status: session.status,
    currentQuestion: question
      ? {
          id: question.id,
          text: question.text,
          emoji: question.emoji,
          image: question.image,
          answers: question.answers.map(({ id: answerId, text }) => ({ id: answerId, text })),
        }
      : null,
  };
}
