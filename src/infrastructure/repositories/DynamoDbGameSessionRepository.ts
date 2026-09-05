import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import type { GameSessionRepository } from "../../application/game/GameSessionRepository.ts";
import type { GameSession } from "../../domain/game/types.ts";

interface DocumentClient {
  send(command: object): Promise<unknown>;
}

export class DynamoDbGameSessionRepository implements GameSessionRepository {
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

  async create(id: string, session: GameSession): Promise<void> {
    const timestamp = this.now();
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { sessionId: id, ...session, createdAt: timestamp, updatedAt: timestamp, completedAt: null },
        ConditionExpression: "attribute_not_exists(sessionId)",
      }));
    } catch (error) {
      throw translatePersistenceError(error, "create-game-session", id);
    }
  }

  async findById(id: string): Promise<GameSession | null> {
    let result: { Item?: unknown };
    try {
      result = (await this.client.send(new GetCommand({ TableName: this.tableName, Key: { sessionId: id }, ConsistentRead: true }))) as { Item?: unknown };
    } catch (error) {
      throw translatePersistenceError(error, "get-game-session", id);
    }
    return result.Item === undefined ? null : toSession(result.Item);
  }

  async update(id: string, session: GameSession, expectedRevision: number): Promise<void> {
    const timestamp = this.now();
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { sessionId: id },
        UpdateExpression: "SET #gameId = :gameId, #player = :player, #category = :category, #difficulty = :difficulty, #questions = :questions, #currentQuestionIndex = :currentQuestionIndex, #score = :score, #answers = :answers, #selectedAnswerId = :selectedAnswerId, #status = :status, #revision = :revision, #updatedAt = :updatedAt, #completedAt = :completedAt",
        ConditionExpression: "#revision = :expectedRevision",
        ExpressionAttributeNames: {
          "#gameId": "gameId", "#player": "player", "#category": "category", "#difficulty": "difficulty", "#questions": "questions",
          "#currentQuestionIndex": "currentQuestionIndex", "#score": "score", "#answers": "answers",
          "#selectedAnswerId": "selectedAnswerId", "#status": "status", "#revision": "revision",
          "#updatedAt": "updatedAt", "#completedAt": "completedAt",
        },
        ExpressionAttributeValues: {
          ":gameId": session.gameId, ":player": session.player, ":category": session.category, ":difficulty": session.difficulty,
          ":questions": session.questions, ":currentQuestionIndex": session.currentQuestionIndex, ":score": session.score,
          ":answers": session.answers, ":selectedAnswerId": session.selectedAnswerId, ":status": session.status,
          ":revision": session.revision, ":expectedRevision": expectedRevision, ":updatedAt": timestamp,
          ":completedAt": session.status === "completed" ? timestamp : null,
        },
      }));
    } catch (error) {
      throw translatePersistenceError(error, "update-game-session", id);
    }
  }
}

function toSession(value: unknown): GameSession {
  if (!value || typeof value !== "object") throw new Error("DynamoDB returned an invalid game session record.");
  const item = value as Partial<GameSession>;
  if (!item.player || !hasValidPlayerAge(item.player) || !item.category || !item.difficulty || !Array.isArray(item.questions) || !Array.isArray(item.answers) || typeof item.currentQuestionIndex !== "number" || typeof item.score !== "number" || typeof item.revision !== "number" || (item.status !== "playing" && item.status !== "completed")) {
    throw new Error("DynamoDB returned an invalid game session record.");
  }
  return {
    gameId: typeof item.gameId === "string" ? item.gameId : item.category.id,
    revision: item.revision,
    player: item.player,
    category: item.category,
    difficulty: item.difficulty,
    questions: item.questions,
    currentQuestionIndex: item.currentQuestionIndex,
    score: item.score,
    answers: item.answers,
    selectedAnswerId: typeof item.selectedAnswerId === "string" ? item.selectedAnswerId : null,
    status: item.status,
  };
}

function hasValidPlayerAge(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("age" in value)) return false;
  const { age } = value as { age?: unknown };
  return typeof age === "number" && Number.isInteger(age) && age > 0;
}

function translatePersistenceError(error: unknown, operation: string, resourceId?: string): ApplicationError | PersistenceError {
  if (error instanceof ApplicationError || error instanceof PersistenceError) return error;
  if (error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException") {
    return new ApplicationError("SESSION_CONFLICT", "The game session changed before this request could be saved.");
  }
  return new PersistenceError(operation, error, resourceId);
}
