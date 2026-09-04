import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { PersistenceError } from "../../application/errors.ts";
import type { Game, Player, Category, Question } from "../../domain/game/types.ts";
import type { GameRepository, QuestionCriteria } from "../../repositories/game/GameRepository.ts";
import { gameRecordToDomain, isGameRecord } from "./gameSeed.ts";

interface DocumentClient {
  send(command: object): Promise<unknown>;
}

export class DynamoDbGameRepository implements GameRepository {
  private readonly client: DocumentClient;
  private readonly tableName: string;

  constructor(
    client: DocumentClient,
    tableName: string,
  ) {
    this.client = client;
    this.tableName = tableName;
  }

  async findAll(): Promise<Game[]> {
    let result: { Items?: unknown[] };
    try {
      result = (await this.client.send(new ScanCommand({ TableName: this.tableName }))) as { Items?: unknown[] };
    } catch (error) {
      throw preserveOrTranslate(error, "list-games");
    }
    return (result.Items ?? [])
      .map((item) => ({ game: toGame(item), sortOrder: readSortOrder(item) }))
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ game }) => game);
  }

  async findById(id: string): Promise<Game | null> {
    let result: { Item?: unknown };
    try {
      result = (await this.client.send(new GetCommand({ TableName: this.tableName, Key: { gameId: id }, ConsistentRead: true }))) as { Item?: unknown };
    } catch (error) {
      throw preserveOrTranslate(error, "get-game", id);
    }
    return result.Item === undefined ? null : toGame(result.Item);
  }

  async getPlayers(): Promise<Player[]> {
    const games = await this.findAll();
    const players = new Map<string, Player>();
    for (const game of games) for (const player of game.players) players.set(player.id, player);
    return [...players.values()];
  }

  async getCategories(): Promise<Category[]> {
    return (await this.findAll()).map((game) => game.category);
  }

  async getQuestions(criteria: QuestionCriteria = {}): Promise<Question[]> {
    const games = criteria.categoryId
      ? [await this.findById(criteria.categoryId)].filter((game): game is Game => game !== null)
      : await this.findAll();
    return games.flatMap((game) => game.questions).filter((question) => !criteria.difficulty || question.difficulty === criteria.difficulty);
  }
}

function preserveOrTranslate(error: unknown, operation: string, resourceId?: string): PersistenceError {
  return error instanceof PersistenceError ? error : new PersistenceError(operation, error, resourceId);
}

function toGame(value: unknown): Game {
  if (!isGameRecord(value)) throw new Error("DynamoDB returned an invalid game record.");
  return gameRecordToDomain(value);
}

function readSortOrder(value: unknown): number {
  return isGameRecord(value) ? value.sortOrder : Number.MAX_SAFE_INTEGER;
}
