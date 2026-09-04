import gameData from "../../data/games.json" with { type: "json" };
import type {
  Category,
  Game,
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
  async findAll(): Promise<Game[]> {
    return data.categories.map((category) => ({
      id: category.id,
      title: category.name,
      category,
      players: [...data.players],
      questions: data.questions.filter((question) => question.categoryId === category.id),
    }));
  }

  async findById(id: string): Promise<Game | null> {
    return (await this.findAll()).find((game) => game.id === id) ?? null;
  }

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
