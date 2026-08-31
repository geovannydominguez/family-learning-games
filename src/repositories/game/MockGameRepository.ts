import gameData from "../../data/games.json" with { type: "json" };
import type {
  Category,
  Player,
  Question,
} from "../../domain/game/types.ts";

import type { GameRepository, QuestionCriteria } from "./GameRepository.ts";

interface LocalGameData {
  players: Player[];
  categories: Category[];
  questions: Question[];
}

const data = gameData as LocalGameData;

export class MockGameRepository implements GameRepository {
  async getPlayers(): Promise<Player[]> {
    return [...data.players];
  }

  async getCategories(): Promise<Category[]> {
    return [...data.categories];
  }

  async getQuestions(criteria: QuestionCriteria = {}): Promise<Question[]> {
    return data.questions.filter(
      (question) =>
        (!criteria.categoryId || question.categoryId === criteria.categoryId) &&
        (!criteria.difficulty || question.difficulty === criteria.difficulty),
    );
  }
}
