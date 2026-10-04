export type Difficulty = "easy" | "normal" | "hard";

export interface Player {
  id: string;
  name: string;
  avatar: string;
  age: number;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface Answer {
  id: string;
  text: string;
  isCorrect: boolean;
}

/**
 * Logical reference to an application-controlled (curated) image (v0.8,
 * ADR-016). `assetId` is a provider-independent identifier — never an S3 URL,
 * bucket name, object key or signed URL.
 */
export interface QuestionImage {
  assetId: string;
  altText: string;
}

export interface QuestionMedia {
  image?: QuestionImage;
}

export interface Question {
  id: string;
  categoryId: string;
  difficulty: Difficulty;
  text: string;
  answers: Answer[];
  emoji?: string;
  /**
   * Legacy free-form reference (v0.1+), still passed through unchanged in the
   * public `image` field for backward compatibility. It is not a controlled
   * asset (ADR-016); v0.8 images use `media.image`.
   */
  image?: string;
  /** Optional controlled media (v0.8). Questions without it remain fully valid. */
  media?: QuestionMedia;
}

export interface PlayerAnswer {
  questionId: string;
  answerId: string;
  isCorrect: boolean;
}

export interface GameSession {
  gameId: string;
  revision: number;
  player: Player;
  /**
   * The persistent family player profile (see `domain/player/types.ts`)
   * associated with this session, when started through the v0.6 flow.
   * Optional so historical sessions created before v0.6 remain valid
   * (FR-10/FR-12): they simply have no value here.
   */
  playerId?: string;
  category: Category;
  difficulty: Difficulty;
  questions: Question[];
  currentQuestionIndex: number;
  score: number;
  answers: PlayerAnswer[];
  selectedAnswerId: string | null;
  status: "playing" | "completed";
}

export interface Game {
  id: string;
  title: string;
  category: Category;
  players: Player[];
  questions: Question[];
  /**
   * The generation context a game was created with (v0.6). Preserved so a
   * game's original age/difficulty context survives later profile edits
   * (ADR-013's historical-behavior rule). Never carries player identity.
   */
  generationMetadata?: {
    targetAge?: number;
    difficulty?: Difficulty;
  };
}

export interface Result {
  player: Player;
  category: Category;
  difficulty: Difficulty;
  score: number;
  total: number;
}
