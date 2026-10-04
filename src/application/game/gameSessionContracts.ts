import type { Category, Difficulty, Player } from "../../domain/game/types.ts";
import type { PublicQuestionImage } from "../media/questionImages.ts";

export interface PublicAnswer {
  id: string;
  text: string;
}

export interface PublicQuestion {
  id: string;
  text: string;
  answers: PublicAnswer[];
  emoji?: string;
  /**
   * Legacy public field (since v0.2): the persisted free-form `Question.image`
   * passed through unchanged. Kept for backward compatibility; it is not a
   * controlled v0.8 asset and the v0.8 frontend does not render it.
   */
  image?: string;
  /** v0.8 (ADR-016), additive: resolved controlled media. Absent when there is none. */
  media?: PublicQuestionMedia;
}

export interface PublicQuestionMedia {
  /** Short-lived signed URL plus alt text. Never an asset ID, bucket name or object key. */
  image?: PublicQuestionImage;
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
  /** v0.8: the persisted game the session plays, needed to request question audio. */
  gameId?: string;
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
