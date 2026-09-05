import gameData from "../../data/games.json" with { type: "json" };
import { ApplicationError } from "../../application/errors.ts";
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
  private readonly generatedGames = new Map<string, Game>();

  async create(game: Game): Promise<void> {
    if (await this.findById(game.id)) {
      throw new ApplicationError("GAME_ID_CONFLICT", "A game with this ID already exists.");
    }
    this.generatedGames.set(game.id, game);
  }

  async findAll(): Promise<Game[]> {
    const seededGames = data.categories.map((category) => ({
      id: category.id,
      title: category.name,
      category,
      players: [...data.players],
      questions: data.questions.filter((question) => question.categoryId === category.id),
    }));
    return [...seededGames, ...this.generatedGames.values()];
  }

  async findById(id: string): Promise<Game | null> {
    return (await this.findAll()).find((game) => game.id === id) ?? null;
  }

  async getPlayers(): Promise<Player[]> {
    const players = new Map<string, Player>();
    for (const game of await this.findLegacySetupGames()) {
      for (const player of game.players) players.set(player.id, player);
    }
    return [...players.values()];
  }

  async getCategories(): Promise<Category[]> {
    const categories = new Map<string, Category>();
    for (const game of await this.findLegacySetupGames()) categories.set(game.category.id, game.category);
    return [...categories.values()];
  }

  async getQuestions(criteria: QuestionCriteria = {}): Promise<Question[]> {
    return (await this.findAll())
      .filter((game) => !criteria.categoryId || game.category.id === criteria.categoryId)
      .flatMap((game) => game.questions)
      .filter((question) => !criteria.difficulty || question.difficulty === criteria.difficulty);
  }

  private async findLegacySetupGames(): Promise<Game[]> {
    return (await this.findAll()).filter((game) => game.id === game.category.id);
  }
}
