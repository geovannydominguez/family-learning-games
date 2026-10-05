import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { PersistenceError } from "../../application/errors.ts";
import type { ConnectionBinding, MultiplayerRepository, QuestionOpening, RecordAnswerOutcome } from "../../application/multiplayer/ports.ts";
import type { MultiplayerAnswer, MultiplayerMember, MultiplayerRoom, MultiplayerScore } from "../../domain/multiplayer/types.ts";

interface DocumentClient {
  send(command: object): Promise<unknown>;
}

type Item = Record<string, unknown>;

const roomPk = (roomId: string) => `ROOM#${roomId}`;
const codePk = (roomCode: string) => `CODE#${roomCode}`;
const connectionPk = (connectionId: string) => `CONNECTION#${connectionId}`;
const memberSk = (playerId: string) => `PLAYER#${playerId}`;
const answerSk = (questionId: string, playerId: string) => `ANSWER#${questionId}#${playerId}`;
const scoreFields: ReadonlyArray<keyof MultiplayerScore> = [
  "correctAnswers",
  "totalPoints",
  "firstPlaceCorrectAnswers",
  "secondPlaceCorrectAnswers",
  "thirdPlaceCorrectAnswers",
  "cumulativeCorrectResponseTimeMs",
];

/**
 * Single-table DynamoDB implementation of `MultiplayerRepository` (ADR-019):
 *
 *   CODE#<roomCode>          / RESERVATION        room-code uniqueness + lookup
 *   ROOM#<roomId>            / META               room state
 *   ROOM#<roomId>            / PLAYER#<playerId>  membership + score aggregates
 *   ROOM#<roomId>            / ANSWER#<qid>#<pid> one accepted answer
 *   CONNECTION#<connectionId>/ META               reverse lookup for $disconnect
 *
 * Every item carries `expiresAt` (epoch seconds, TTL). Invariants that span
 * items use `TransactWriteItems`; the rest use conditional writes. Reads that
 * gate a transition are strongly consistent.
 */
export class DynamoDbMultiplayerRepository implements MultiplayerRepository {
  private readonly client: DocumentClient;
  private readonly tableName: string;

  constructor(client: DocumentClient, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  async createRoom(room: MultiplayerRoom, host: MultiplayerMember, nowMs: number): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { PK: codePk(room.roomCode), SK: "RESERVATION", entityType: "ROOM_CODE", roomId: room.roomId, roomCode: room.roomCode, expiresAt: room.expiresAt },
              // An expired reservation (not yet removed by TTL) may be reused.
              ConditionExpression: "attribute_not_exists(PK) OR #expiresAt <= :nowSeconds",
              ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
              ExpressionAttributeValues: { ":nowSeconds": Math.floor(nowMs / 1_000) },
            },
          },
          { Put: { TableName: this.tableName, Item: roomItem(room), ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: this.tableName, Item: memberItem(host), ConditionExpression: "attribute_not_exists(PK)" } },
        ],
      }));
      return true;
    } catch (error) {
      if (cancellationCodes(error)) return false;
      throw new PersistenceError("create-multiplayer-room", error, room.roomId);
    }
  }

  async findRoomIdByCode(roomCode: string): Promise<string | null> {
    const item = await this.get({ PK: codePk(roomCode), SK: "RESERVATION" }, "find-multiplayer-room-code");
    return item && typeof item.roomId === "string" ? item.roomId : null;
  }

  async getRoom(roomId: string): Promise<MultiplayerRoom | null> {
    const item = await this.get({ PK: roomPk(roomId), SK: "META" }, "get-multiplayer-room", roomId);
    return item ? toRoom(item) : null;
  }

  async getMember(roomId: string, playerId: string): Promise<MultiplayerMember | null> {
    const item = await this.get({ PK: roomPk(roomId), SK: memberSk(playerId) }, "get-multiplayer-member", roomId);
    return item ? toMember(item) : null;
  }

  async listMembers(roomId: string): Promise<MultiplayerMember[]> {
    return (await this.query(roomPk(roomId), "PLAYER#", "list-multiplayer-members", roomId)).map(toMember);
  }

  async addMember(member: MultiplayerMember, limits: { maxPlayers: number; nowMs: number }): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: roomPk(member.roomId), SK: "META" },
              UpdateExpression: "SET #memberCount = #memberCount + :one, #version = #version + :one",
              ConditionExpression: "#status = :waiting AND #memberCount < :maxPlayers AND #expiresAt > :nowSeconds",
              ExpressionAttributeNames: { "#memberCount": "memberCount", "#version": "version", "#status": "status", "#expiresAt": "expiresAt" },
              ExpressionAttributeValues: { ":one": 1, ":waiting": "WAITING", ":maxPlayers": limits.maxPlayers, ":nowSeconds": Math.floor(limits.nowMs / 1_000) },
            },
          },
          { Put: { TableName: this.tableName, Item: memberItem(member), ConditionExpression: "attribute_not_exists(PK)" } },
        ],
      }));
      return true;
    } catch (error) {
      if (cancellationCodes(error)) return false;
      throw new PersistenceError("add-multiplayer-member", error, member.roomId);
    }
  }

  async startRoom(roomId: string, expectedVersion: number, opening: QuestionOpening): Promise<boolean> {
    return this.conditionalUpdate("start-multiplayer-room", roomId, {
      UpdateExpression: `${openingSet} , #status = :inProgress`,
      ConditionExpression: "#status = :waiting AND #version = :expectedVersion",
      ExpressionAttributeNames: { ...openingNames, "#status": "status" },
      ExpressionAttributeValues: { ...openingValues(opening), ":inProgress": "IN_PROGRESS", ":waiting": "WAITING", ":expectedVersion": expectedVersion },
    });
  }

  async openNextQuestion(roomId: string, fromQuestionIndex: number, opening: QuestionOpening): Promise<boolean> {
    return this.conditionalUpdate("open-multiplayer-question", roomId, {
      UpdateExpression: `${openingSet} REMOVE #lastReveal`,
      ConditionExpression: "#status = :inProgress AND #questionState = :revealed AND #currentQuestionIndex = :fromIndex",
      ExpressionAttributeNames: { ...openingNames, "#status": "status", "#lastReveal": "lastReveal" },
      ExpressionAttributeValues: { ...openingValues(opening), ":inProgress": "IN_PROGRESS", ":revealed": "REVEALED", ":fromIndex": fromQuestionIndex },
    });
  }

  async recordAnswer(answer: MultiplayerAnswer, questionIndex: number, nowMs: number): Promise<RecordAnswerOutcome> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { PK: roomPk(answer.roomId), SK: answerSk(answer.questionId, answer.playerId), entityType: "ANSWER", ...answer },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: roomPk(answer.roomId), SK: "META" },
              UpdateExpression: "SET #answeredCount = #answeredCount + :one",
              ConditionExpression: "#status = :inProgress AND #questionState = :open AND #currentQuestionIndex = :questionIndex AND #questionDeadlineAt > :now",
              ExpressionAttributeNames: {
                "#answeredCount": "answeredCount", "#status": "status", "#questionState": "questionState",
                "#currentQuestionIndex": "currentQuestionIndex", "#questionDeadlineAt": "questionDeadlineAt",
              },
              ExpressionAttributeValues: { ":one": 1, ":inProgress": "IN_PROGRESS", ":open": "OPEN", ":questionIndex": questionIndex, ":now": nowMs },
            },
          },
        ],
      }));
      return "accepted";
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes) return codes[0] === "ConditionalCheckFailed" ? "duplicate" : "closed";
      throw new PersistenceError("record-multiplayer-answer", error, answer.roomId);
    }
  }

  async listAnswers(roomId: string, questionId: string): Promise<MultiplayerAnswer[]> {
    return (await this.query(roomPk(roomId), `ANSWER#${questionId}#`, "list-multiplayer-answers", roomId)).map(toAnswer);
  }

  async revealQuestion(input: Parameters<MultiplayerRepository["revealQuestion"]>[0]): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: roomPk(input.roomId), SK: "META" },
              UpdateExpression: `SET #questionState = :revealed, #lastReveal = :reveal, #version = #version + :one${input.finish ? ", #status = :finished" : ""}`,
              ConditionExpression: "#questionState = :open AND #currentQuestionIndex = :questionIndex AND #answeredCount = :expectedAnsweredCount",
              ExpressionAttributeNames: {
                "#questionState": "questionState", "#lastReveal": "lastReveal", "#version": "version",
                "#currentQuestionIndex": "currentQuestionIndex", "#answeredCount": "answeredCount",
                ...(input.finish ? { "#status": "status" } : {}),
              },
              ExpressionAttributeValues: {
                ":revealed": "REVEALED", ":reveal": input.reveal, ":one": 1, ":open": "OPEN",
                ":questionIndex": input.questionIndex, ":expectedAnsweredCount": input.expectedAnsweredCount,
                ...(input.finish ? { ":finished": "FINISHED" } : {}),
              },
            },
          },
          // Score deltas commit in the same transaction as the reveal: scored exactly once.
          ...input.scoreDeltas.map(({ playerId, delta }) => ({
            Update: {
              TableName: this.tableName,
              Key: { PK: roomPk(input.roomId), SK: memberSk(playerId) },
              UpdateExpression: `ADD ${scoreFields.map((field) => `#${field} :${field}`).join(", ")}`,
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeNames: Object.fromEntries(scoreFields.map((field) => [`#${field}`, field])),
              ExpressionAttributeValues: Object.fromEntries(scoreFields.map((field) => [`:${field}`, delta[field]])),
            },
          })),
        ],
      }));
      return true;
    } catch (error) {
      if (cancellationCodes(error)) return false;
      throw new PersistenceError("reveal-multiplayer-question", error, input.roomId);
    }
  }

  async bindConnection(binding: Parameters<MultiplayerRepository["bindConnection"]>[0]): Promise<void> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: roomPk(binding.roomId), SK: memberSk(binding.playerId) },
              UpdateExpression: "SET #connectionId = :connectionId, #connectedAt = :now",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeNames: { "#connectionId": "connectionId", "#connectedAt": "connectedAt" },
              ExpressionAttributeValues: { ":connectionId": binding.connectionId, ":now": binding.nowMs },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: connectionPk(binding.connectionId), SK: "META", entityType: "CONNECTION",
                roomId: binding.roomId, playerId: binding.playerId, connectedAt: binding.nowMs, expiresAt: binding.expiresAt,
              },
            },
          },
          ...(binding.previousConnectionId
            ? [{ Delete: { TableName: this.tableName, Key: { PK: connectionPk(binding.previousConnectionId), SK: "META" } } }]
            : []),
        ],
      }));
    } catch (error) {
      throw new PersistenceError("bind-multiplayer-connection", error, binding.roomId);
    }
  }

  async getConnection(connectionId: string): Promise<ConnectionBinding | null> {
    const item = await this.get({ PK: connectionPk(connectionId), SK: "META" }, "get-multiplayer-connection");
    return item && typeof item.roomId === "string" && typeof item.playerId === "string"
      ? { roomId: item.roomId, playerId: item.playerId }
      : null;
  }

  async releaseConnection(connectionId: string): Promise<(ConnectionBinding & { wasActive: boolean }) | null> {
    const binding = await this.getConnection(connectionId);
    if (!binding) return null;
    try {
      await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: connectionPk(connectionId), SK: "META" } }));
    } catch (error) {
      throw new PersistenceError("release-multiplayer-connection", error, binding.roomId);
    }
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: roomPk(binding.roomId), SK: memberSk(binding.playerId) },
        UpdateExpression: "REMOVE #connectionId",
        // A newer connection (reconnect) must not be cleared by a late disconnect of the old one.
        ConditionExpression: "#connectionId = :connectionId",
        ExpressionAttributeNames: { "#connectionId": "connectionId" },
        ExpressionAttributeValues: { ":connectionId": connectionId },
      }));
      return { ...binding, wasActive: true };
    } catch (error) {
      if (isConditionalFailure(error)) return { ...binding, wasActive: false };
      throw new PersistenceError("release-multiplayer-connection", error, binding.roomId);
    }
  }

  private async conditionalUpdate(operation: string, roomId: string, update: Pick<ConstructorParameters<typeof UpdateCommand>[0], "UpdateExpression" | "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues">): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({ TableName: this.tableName, Key: { PK: roomPk(roomId), SK: "META" }, ...update }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw new PersistenceError(operation, error, roomId);
    }
  }

  private async get(key: { PK: string; SK: string }, operation: string, resourceId?: string): Promise<Item | null> {
    try {
      const result = (await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item };
      return result.Item ?? null;
    } catch (error) {
      throw new PersistenceError(operation, error, resourceId);
    }
  }

  private async query(pk: string, skPrefix: string, operation: string, resourceId: string): Promise<Item[]> {
    const items: Item[] = [];
    let exclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
    try {
      do {
        const result = (await this.client.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": skPrefix },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }))) as { Items?: Item[]; LastEvaluatedKey?: QueryCommandInput["ExclusiveStartKey"] };
        items.push(...(result.Items ?? []));
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (error) {
      throw new PersistenceError(operation, error, resourceId);
    }
    return items;
  }
}

const openingSet = "SET #currentQuestionIndex = :questionIndex, #questionState = :open, #questionStartedAt = :startedAt, #questionDeadlineAt = :deadlineAt, #eligiblePlayerIds = :eligible, #answeredCount = :zero, #version = #version + :one";
const openingNames = {
  "#currentQuestionIndex": "currentQuestionIndex",
  "#questionState": "questionState",
  "#questionStartedAt": "questionStartedAt",
  "#questionDeadlineAt": "questionDeadlineAt",
  "#eligiblePlayerIds": "eligiblePlayerIds",
  "#answeredCount": "answeredCount",
  "#version": "version",
};

function openingValues(opening: QuestionOpening): Item {
  return {
    ":questionIndex": opening.questionIndex,
    ":open": "OPEN",
    ":startedAt": opening.questionStartedAt,
    ":deadlineAt": opening.questionDeadlineAt,
    ":eligible": opening.eligiblePlayerIds,
    ":zero": 0,
    ":one": 1,
  };
}

function roomItem(room: MultiplayerRoom): Item {
  return { PK: roomPk(room.roomId), SK: "META", entityType: "ROOM", ...room };
}

function memberItem(member: MultiplayerMember): Item {
  const { score, ...rest } = member;
  return { PK: roomPk(member.roomId), SK: memberSk(member.playerId), entityType: "PLAYER_MEMBERSHIP", ...rest, ...score };
}

function toRoom(item: Item): MultiplayerRoom {
  const room: MultiplayerRoom = {
    roomId: readString(item, "roomId"),
    roomCode: readString(item, "roomCode"),
    gameId: readString(item, "gameId"),
    hostPlayerId: readString(item, "hostPlayerId"),
    status: readString(item, "status") as MultiplayerRoom["status"],
    questionIds: Array.isArray(item.questionIds) ? item.questionIds.map(String) : [],
    currentQuestionIndex: readNumber(item, "currentQuestionIndex"),
    questionState: readString(item, "questionState") as MultiplayerRoom["questionState"],
    questionTimeLimitSeconds: readNumber(item, "questionTimeLimitSeconds"),
    eligiblePlayerIds: Array.isArray(item.eligiblePlayerIds) ? item.eligiblePlayerIds.map(String) : [],
    answeredCount: readNumber(item, "answeredCount"),
    memberCount: readNumber(item, "memberCount"),
    version: readNumber(item, "version"),
    createdAt: readNumber(item, "createdAt"),
    expiresAt: readNumber(item, "expiresAt"),
  };
  if (typeof item.questionStartedAt === "number") room.questionStartedAt = item.questionStartedAt;
  if (typeof item.questionDeadlineAt === "number") room.questionDeadlineAt = item.questionDeadlineAt;
  if (item.lastReveal && typeof item.lastReveal === "object") room.lastReveal = item.lastReveal as MultiplayerRoom["lastReveal"];
  return room;
}

function toMember(item: Item): MultiplayerMember {
  const member: MultiplayerMember = {
    roomId: readString(item, "roomId"),
    playerId: readString(item, "playerId"),
    displayName: readString(item, "displayName"),
    role: readString(item, "role") === "HOST" ? "HOST" : "PLAYER",
    participantTokenHash: readString(item, "participantTokenHash"),
    joinedAt: readNumber(item, "joinedAt"),
    score: Object.fromEntries(scoreFields.map((field) => [field, typeof item[field] === "number" ? item[field] : 0])) as unknown as MultiplayerScore,
    expiresAt: readNumber(item, "expiresAt"),
  };
  if (typeof item.connectionId === "string") member.connectionId = item.connectionId;
  return member;
}

function toAnswer(item: Item): MultiplayerAnswer {
  return {
    roomId: readString(item, "roomId"),
    questionId: readString(item, "questionId"),
    playerId: readString(item, "playerId"),
    answerId: readString(item, "answerId"),
    serverReceivedAtMs: readNumber(item, "serverReceivedAtMs"),
    responseDurationMs: readNumber(item, "responseDurationMs"),
    isCorrect: item.isCorrect === true,
    expiresAt: readNumber(item, "expiresAt"),
  };
}

function readString(item: Item, key: string): string {
  const value = item[key];
  if (typeof value !== "string") throw new Error(`DynamoDB returned an invalid multiplayer record (${key}).`);
  return value;
}

function readNumber(item: Item, key: string): number {
  const value = item[key];
  if (typeof value !== "number") throw new Error(`DynamoDB returned an invalid multiplayer record (${key}).`);
  return value;
}

function isConditionalFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
}

/** Per-item cancellation codes of a conditionally cancelled transaction; `null` for any other failure. */
function cancellationCodes(error: unknown): string[] | null {
  if (!error || typeof error !== "object" || !("name" in error) || error.name !== "TransactionCanceledException") return null;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  const codes = reasons.map((reason) => reason.Code ?? "None");
  return codes.includes("ConditionalCheckFailed") ? codes : null;
}
