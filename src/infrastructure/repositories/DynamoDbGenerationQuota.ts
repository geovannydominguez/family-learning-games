import { randomUUID } from "node:crypto";

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { PersistenceError } from "../../application/errors.ts";
import type {
  GenerationQuota,
  GenerationQuotaOutcome,
  GenerationQuotaReservation,
} from "../../application/game/GenerationQuota.ts";

interface DocumentClient {
  send(command: object): Promise<unknown>;
}

/** Partition of the quota items inside the ephemeral multiplayer/coordination table (ADR-021). */
export const generationQuotaPk = "QUOTA#AI_GENERATION";
export const generationQuotaSk = (periodKey: string) => `DAY#${periodKey}`;
/** Must match the table's configured TTL attribute (`timeToLiveAttribute` in the CDK stack). */
export const generationQuotaTtlAttribute = "expiresAt";
const operation = "reserve-ai-generation-quota";
const periodKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * v0.9.3 — ADR-021: one conditional `UpdateItem` per admitted generation.
 *
 *   PK = QUOTA#AI_GENERATION   SK = DAY#<YYYY-MM-DD>   (one item per local day)
 *   used          N   admitted requests in the period
 *   reservations  SS  one opaque random id per admitted request
 *   expiresAt     N   TTL cleanup only (never read to decide admission)
 *
 * Concurrency: DynamoDB serializes conditional writes on one item, so the
 * condition `used < limit` admits at most `limit` reservations per period, and
 * the first reservation of a day creates the item (`attribute_not_exists`). A new
 * day is a new item; it never depends on TTL having deleted the previous one.
 *
 * SDK retries: the AWS SDK may resend the SAME request after a transport error
 * or throttling, even when the first attempt was applied. Each call carries one
 * fresh `reservationId` and the condition `NOT contains(reservations, id)`, so a
 * resend of an applied attempt cannot increment twice: it fails the condition,
 * and the returned old item (`ReturnValuesOnConditionCheckFailure: ALL_OLD`)
 * shows the id, which proves the reservation was already confirmed. Hence at
 * most one unit per call. When the final outcome is still unknown (every attempt
 * failed without a definite answer), the error is thrown: the caller fails
 * closed without calling Bedrock and one unit may be lost. Exactly-once is not
 * claimed.
 */
export class DynamoDbGenerationQuota implements GenerationQuota {
  private readonly client: DocumentClient;
  private readonly tableName: string;
  private readonly createReservationId: () => string;

  constructor(client: DocumentClient, tableName: string, options: { createReservationId?: () => string } = {}) {
    this.client = client;
    this.tableName = tableName;
    this.createReservationId = options.createReservationId ?? randomUUID;
  }

  async reserve(reservation: GenerationQuotaReservation): Promise<GenerationQuotaOutcome> {
    if (!periodKeyPattern.test(reservation.periodKey)) throw new Error("Invalid generation quota period.");
    if (!Number.isInteger(reservation.limit) || reservation.limit < 1) throw new Error("Invalid generation quota limit.");
    const reservationId = this.createReservationId();
    let result: unknown;
    try {
      result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: generationQuotaPk, SK: generationQuotaSk(reservation.periodKey) },
        UpdateExpression: "ADD #used :one, #reservations :reservation SET #expiresAt = if_not_exists(#expiresAt, :expiresAt), #entityType = :entityType",
        ConditionExpression: "(attribute_not_exists(#used) OR #used < :limit) AND NOT contains(#reservations, :reservationId)",
        ExpressionAttributeNames: {
          "#used": "used",
          "#reservations": "reservations",
          "#expiresAt": generationQuotaTtlAttribute,
          "#entityType": "entityType",
        },
        ExpressionAttributeValues: {
          ":one": 1,
          ":reservation": new Set([reservationId]),
          ":reservationId": reservationId,
          ":limit": reservation.limit,
          ":expiresAt": reservation.expiresAtEpochSeconds,
          ":entityType": "AI_GENERATION_QUOTA",
        },
        ReturnValues: "UPDATED_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }));
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        const old = readOldItem(error);
        // A resent attempt of this same call that had already been applied.
        if (old.reservations.has(reservationId)) return { status: "reserved", used: old.used ?? reservation.limit };
        return { status: "exhausted", ...(old.used !== undefined ? { used: old.used } : {}) };
      }
      throw new PersistenceError(operation, error);
    }
    const used = readNumber((result as { Attributes?: Record<string, unknown> } | undefined)?.Attributes?.used);
    if (used === undefined) throw new PersistenceError(operation, new Error("MissingQuotaCounter"));
    return { status: "reserved", used };
  }
}

function isConditionalCheckFailed(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
}

/**
 * `ConditionalCheckFailedException.Item` carries the old item in DynamoDB's raw
 * AttributeValue form (the document client does not unmarshall errors). Both raw
 * (`{ N }`, `{ SS }`) and native (number, Set, array) shapes are accepted.
 */
function readOldItem(error: unknown): { used?: number; reservations: Set<string> } {
  const item = (error as { Item?: Record<string, unknown> }).Item ?? {};
  return { used: readNumber(item.used), reservations: readStringSet(item.reservations) };
}

function readNumber(value: unknown): number | undefined {
  const raw = value && typeof value === "object" && "N" in value ? (value as { N: unknown }).N : value;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStringSet(value: unknown): Set<string> {
  const raw = value && typeof value === "object" && "SS" in value ? (value as { SS: unknown }).SS : value;
  if (raw instanceof Set) return new Set([...raw].filter((entry): entry is string => typeof entry === "string"));
  if (Array.isArray(raw)) return new Set(raw.filter((entry): entry is string => typeof entry === "string"));
  return new Set();
}
