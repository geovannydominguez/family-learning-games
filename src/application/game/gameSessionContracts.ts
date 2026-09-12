import type { Category, Difficulty, Player } from "../../domain/game/types.ts";

export interface PublicAnswer {
  id: string;
  text: string;
}

export interface PublicQuestion {
  id: string;
  text: string;
  answers: PublicAnswer[];
  emoji?: string;
  image?: string;
}

export interface PublicGameQuestion extends PublicQuestion {
  categoryId: string;
  difficulty: Difficulty;
}

export interface PublicGame {
  id: string;
  title: string;
  category: Category;
  difficulties: Difficulty[];
  questions: PublicGameQuestion[];
  generationMetadata?: {
    targetAge?: number;
    difficulty?: Difficulty;
  };
}

export interface PublicGameSession {
  id: string;
  player: Player;
  /** The persistent family player profile associated with this session (v0.6, optional for historical sessions). */
  playerId?: string;
  category: Category;
  difficulty: Difficulty;
  currentQuestionIndex: number;
  totalQuestions: number;
  score: number;
  status: "playing" | "completed";
  currentQuestion: PublicQuestion | null;
}

export interface GameSetupResponse {
  players: Player[];
  categories: Category[];
  difficulties: Difficulty[];
}

export interface StartGameSessionCommand {
  playerId: string;
  categoryId: string;
  gameId?: string;
  difficulty: Difficulty;
}

export interface AnswerFeedback {
  selectedAnswerId: string;
  correctAnswerId: string;
  correctAnswerText: string;
  isCorrect: boolean;
}

export interface SubmitAnswerResponse {
  feedback: AnswerFeedback;
  nextSession: PublicGameSession;
}
