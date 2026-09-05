import type { Category, Difficulty, Question } from "../../domain/game/types.ts";

export interface GenerateGameRequest {
  topic: string;
  difficulty: Difficulty;
  questionCount: number;
  targetAge: number;
}

export interface GenerateGameCommand {
  topic: string;
  difficulty: Difficulty;
  questionCount: number;
  playerId: string;
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

export class InvalidGeneratedGameCandidateError extends Error {
  constructor() {
    super("Generated game candidate is invalid.");
    this.name = "InvalidGeneratedGameCandidateError";
  }
}
