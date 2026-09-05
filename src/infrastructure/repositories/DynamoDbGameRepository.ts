import {
  GetCommand,
  PutCommand,
  ScanCommand,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import type { Game, Player, Category, Question } from "../../domain/game/types.ts";
import type { GameRepository, QuestionCriteria } from "../../repositories/game/GameRepository.ts";
import { gameDomainToRecord, gameRecordToDomain, isGameRecord } from "./gameSeed.ts";

interface DocumentClient {
  send(command: object): Promise<unknown>;
}

export class DynamoDbGameRepository implements GameRepository {
  private readonly client: DocumentClient;
  private readonly tableName: string;
  private readonly now: () => string;

  constructor(
    client: DocumentClient,
    tableName: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.client = client;
    this.tableName = tableName;
    this.now = now;
  }

  async create(game: Game): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: gameDomainToRecord(game, this.now()),
        ConditionExpression: "attribute_not_exists(gameId)",
      }));
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ApplicationError("GAME_ID_CONFLICT", "A game with this ID already exists.");
      }
      throw preserveOrTranslate(error, "create-game", game.id);
    }
  }

  async findAll(): Promise<Game[]> {
    const items: unknown[] = [];
    let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"];
    try {
      do {
        const result = (await this.client.send(new ScanCommand({
          TableName: this.tableName,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }))) as { Items?: unknown[]; LastEvaluatedKey?: ScanCommandInput["ExclusiveStartKey"] };
        items.push(...(result.Items ?? []));
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (error) {
      throw preserveOrTranslate(error, "list-games");
    }
    return items
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
    const games = await this.findLegacySetupGames();
    const players = new Map<string, Player>();
    for (const game of games) for (const player of game.players) players.set(player.id, player);
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

function isConditionalFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
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
