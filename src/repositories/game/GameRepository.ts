import type {
  Category,
  Difficulty,
  Player,
  Question,
} from "../../domain/game/types.ts";

export interface QuestionCriteria {
  categoryId?: string;
  difficulty?: Difficulty;
}

export interface GameRepository {
  getPlayers(): Promise<Player[]>;
  getCategories(): Promise<Category[]>;
  getQuestions(criteria?: QuestionCriteria): Promise<Question[]>;
}
