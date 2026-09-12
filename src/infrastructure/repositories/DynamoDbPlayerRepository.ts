import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import type { PlayerRepository } from "../../application/player/PlayerRepository.ts";
import type { Player } from "../../domain/player/types.ts";

interface DocumentClient {
  send(command: object): Promise<unknown>;
}

/**
 * DynamoDB implementation of `PlayerRepository` (ADR-012). The `Players`
 * table is expected to be small (family-scale), so `list()` uses a Scan
 * (allowed per ARCHITECTURE-v0.6 — no GSI in v0.6) sorted by `createdAt`
 * client-side, since Scan does not guarantee order.
 */
export class DynamoDbPlayerRepository implements PlayerRepository {
  private readonly client: DocumentClient;
  private readonly tableName: string;

  constructor(client: DocumentClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  async list(): Promise<Player[]> {
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
      throw preserveOrTranslate(error, "list-players");
    }
    return items
      .map((item) => toPlayer(item))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getById(playerId: string): Promise<Player | null> {
    let result: { Item?: unknown };
    try {
      result = (await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: { playerId },
        ConsistentRead: true,
      }))) as { Item?: unknown };
    } catch (error) {
      throw preserveOrTranslate(error, "get-player", playerId);
    }
    return result.Item === undefined ? null : toPlayer(result.Item);
  }

  async create(player: Player): Promise<Player> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: player,
        ConditionExpression: "attribute_not_exists(playerId)",
      }));
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ApplicationError("PLAYER_CONFLICT", "A player with this ID already exists.");
      }
      throw preserveOrTranslate(error, "create-player", player.playerId);
    }
    return player;
  }

  async update(player: Player): Promise<Player> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { playerId: player.playerId },
        UpdateExpression: "SET #name = :name, #age = :age, #createdAt = :createdAt, #updatedAt = :updatedAt",
        ConditionExpression: "attribute_exists(playerId)",
        ExpressionAttributeNames: { "#name": "name", "#age": "age", "#createdAt": "createdAt", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: {
          ":name": player.name,
          ":age": player.age,
          ":createdAt": player.createdAt,
          ":updatedAt": player.updatedAt,
        },
      }));
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new ApplicationError("PLAYER_NOT_FOUND", "Player was not found.");
      }
      throw preserveOrTranslate(error, "update-player", player.playerId);
    }
    return player;
  }

  async delete(playerId: string): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { playerId },
      }));
    } catch (error) {
      throw preserveOrTranslate(error, "delete-player", playerId);
    }
  }
}

function isConditionalFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
}

function preserveOrTranslate(error: unknown, operation: string, resourceId?: string): PersistenceError {
  return error instanceof PersistenceError ? error : new PersistenceError(operation, error, resourceId);
}

function toPlayer(value: unknown): Player {
  if (!isPlayerRecord(value)) throw new Error("DynamoDB returned an invalid player record.");
  return value;
}

function isPlayerRecord(value: unknown): value is Player {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Player>;
  return (
    typeof record.playerId === "string"
    && typeof record.name === "string"
    && typeof record.age === "number"
    && Number.isInteger(record.age)
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string"
  );
}
