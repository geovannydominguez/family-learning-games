export type Difficulty = "easy" | "normal" | "hard";

export interface Player {
  id: string;
  name: string;
  avatar: string;
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

export interface Question {
  id: string;
  categoryId: string;
  difficulty: Difficulty;
  text: string;
  answers: Answer[];
  emoji?: string;
  image?: string;
}

export interface PlayerAnswer {
  questionId: string;
  answerId: string;
  isCorrect: boolean;
}

export interface GameSession {
  player: Player;
  category: Category;
  difficulty: Difficulty;
  questions: Question[];
  currentQuestionIndex: number;
  score: number;
  answers: PlayerAnswer[];
  selectedAnswerId: string | null;
  status: "playing" | "completed";
}

export interface Result {
  player: Player;
  category: Category;
  difficulty: Difficulty;
  score: number;
  total: number;
}

export interface GameSetup {
  players: Player[];
  categories: Category[];
  questions: Question[];
}
