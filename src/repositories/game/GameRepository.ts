import type {
  Category,
  Difficulty,
  Player,
  Question,
  Game,
} from "../../domain/game/types.ts";

export interface QuestionCriteria {
  categoryId?: string;
  difficulty?: Difficulty;
}

export interface GameRepository {
  findAll(): Promise<Game[]>;
  findById(id: string): Promise<Game | null>;
  getPlayers(): Promise<Player[]>;
  getCategories(): Promise<Category[]>;
  getQuestions(criteria?: QuestionCriteria): Promise<Question[]>;
}
