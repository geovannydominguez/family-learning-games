import assert from "node:assert/strict";
import test from "node:test";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { PersistenceError } from "../../application/errors.ts";
import { DynamoDbGenerationQuota, generationQuotaPk, generationQuotaTtlAttribute } from "./DynamoDbGenerationQuota.ts";

const reservation = { periodKey: "2026-11-13", limit: 20, expiresAtEpochSeconds: 1_763_200_000 };

interface QuotaItem { used: number; reservations: Set<string> }

/**
 * Faithful in-process model of the adapter's ONE conditional UpdateItem: the
 * condition and both ADD actions are evaluated and applied in one synchronous
 * step, as DynamoDB serializes writes to a single item. Throws the same
 * `ConditionalCheckFailedException` shape (raw `Item`, ALL_OLD) on failure.
 */
class ConditionalQuotaTable {
  readonly items = new Map<string, QuotaItem>();
  readonly commands: Array<UpdateCommand["input"]> = [];

  apply(input: UpdateCommand["input"]): { Attributes: { used: number } } {
    this.commands.push(input);
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    const key = `${(input.Key as Record<string, string>).PK}|${(input.Key as Record<string, string>).SK}`;
    const id = values[":reservationId"] as string;
    const current = this.items.get(key);
    const admitted = (!current || current.used < (values[":limit"] as number)) && !current?.reservations.has(id);
    if (!admitted) {
      throw Object.assign(new Error("The conditional request failed"), {
        name: "ConditionalCheckFailedException",
        Item: current ? { used: { N: String(current.used) }, reservations: { SS: [...current.reservations] } } : undefined,
      });
    }
    const next = { used: (current?.used ?? 0) + 1, reservations: new Set([...(current?.reservations ?? []), id]) };
    this.items.set(key, next);
    return { Attributes: { used: next.used } };
  }
}

test("sends one conditional UpdateItem on the quota key with the table's TTL attribute", async () => {
  const commands: UpdateCommand[] = [];
  const quota = new DynamoDbGenerationQuota(
    { send: async (command) => { commands.push(command as UpdateCommand); return { Attributes: { used: 1 } }; } },
    "dev-family-learning-games-multiplayer",
    { createReservationId: () => "res-1" },
  );

  assert.deepEqual(await quota.reserve(reservation), { status: "reserved", used: 1 });
  assert.equal(commands.length, 1);
  const input = commands[0].input;
  assert.ok(commands[0] instanceof UpdateCommand);
  assert.equal(input.TableName, "dev-family-learning-games-multiplayer");
  assert.deepEqual(input.Key, { PK: generationQuotaPk, SK: "DAY#2026-11-13" });
  assert.equal(generationQuotaPk, "QUOTA#AI_GENERATION");
  assert.equal(input.ConditionExpression, "(attribute_not_exists(#used) OR #used < :limit) AND NOT contains(#reservations, :reservationId)");
  assert.match(input.UpdateExpression ?? "", /ADD #used :one, #reservations :reservation/);
  assert.match(input.UpdateExpression ?? "", /#expiresAt = if_not_exists\(#expiresAt, :expiresAt\)/);
  assert.equal(input.ExpressionAttributeNames?.["#expiresAt"], "expiresAt");
  assert.equal(generationQuotaTtlAttribute, "expiresAt");
  assert.equal(input.ExpressionAttributeValues?.[":limit"], 20);
  assert.equal(input.ExpressionAttributeValues?.[":reservationId"], "res-1");
  assert.deepEqual(input.ExpressionAttributeValues?.[":reservation"], new Set(["res-1"]));
  assert.equal(input.ExpressionAttributeValues?.[":expiresAt"], reservation.expiresAtEpochSeconds);
  assert.equal(input.ReturnValuesOnConditionCheckFailure, "ALL_OLD");
});

test("first item of the day, last unit, then exhausted (condition semantics)", async () => {
  const table = new ConditionalQuotaTable();
  let sequence = 0;
  const quota = new DynamoDbGenerationQuota({ send: async (command) => table.apply((command as UpdateCommand).input) }, "t", {
    createReservationId: () => `res-${(sequence += 1)}`,
  });
  const limited = { ...reservation, limit: 2 };

  assert.deepEqual(await quota.reserve(limited), { status: "reserved", used: 1 });
  assert.deepEqual(await quota.reserve(limited), { status: "reserved", used: 2 });
  assert.deepEqual(await quota.reserve(limited), { status: "exhausted", used: 2 });
  assert.deepEqual(await quota.reserve(limited), { status: "exhausted", used: 2 });
  assert.equal(table.items.get("QUOTA#AI_GENERATION|DAY#2026-11-13")?.used, 2);
  // A new day is a separate item, independent of TTL cleanup.
  assert.deepEqual(await quota.reserve({ ...limited, periodKey: "2026-11-14" }), { status: "reserved", used: 1 });
});

test("concurrent reservations never exceed the limit", async () => {
  const table = new ConditionalQuotaTable();
  let sequence = 0;
  const quota = new DynamoDbGenerationQuota({
    // Yield first so every request is in flight before any write is applied.
    send: async (command) => { await new Promise((resolve) => setImmediate(resolve)); return table.apply((command as UpdateCommand).input); },
  }, "t", { createReservationId: () => `res-${(sequence += 1)}` });

  const outcomes = await Promise.all(Array.from({ length: 50 }, () => quota.reserve(reservation)));
  assert.equal(outcomes.filter((outcome) => outcome.status === "reserved").length, 20);
  assert.equal(outcomes.filter((outcome) => outcome.status === "exhausted").length, 30);
  assert.equal(table.items.get("QUOTA#AI_GENERATION|DAY#2026-11-13")?.used, 20);
});

test("a resend of an already-applied attempt is recognised by its reservation id and never double-counts", async () => {
  const table = new ConditionalQuotaTable();
  // Emulates the SDK: the first attempt is applied but its response is lost, so
  // the SAME request is sent again inside the same `send` call.
  const quota = new DynamoDbGenerationQuota({
    send: async (command) => {
      const input = (command as UpdateCommand).input;
      table.apply(input);
      return table.apply(input);
    },
  }, "t", { createReservationId: () => "res-retried" });

  assert.deepEqual(await quota.reserve(reservation), { status: "reserved", used: 1 });
  assert.equal(table.items.get("QUOTA#AI_GENERATION|DAY#2026-11-13")?.used, 1);
});

test("a resend of the attempt that took the LAST unit still reports reserved, not exhausted", async () => {
  const table = new ConditionalQuotaTable();
  table.items.set("QUOTA#AI_GENERATION|DAY#2026-11-13", { used: 19, reservations: new Set(["other"]) });
  const quota = new DynamoDbGenerationQuota({
    send: async (command) => { const input = (command as UpdateCommand).input; table.apply(input); return table.apply(input); },
  }, "t", { createReservationId: () => "res-last" });

  assert.deepEqual(await quota.reserve(reservation), { status: "reserved", used: 20 });
  assert.equal(table.items.get("QUOTA#AI_GENERATION|DAY#2026-11-13")?.used, 20);
});

test("technical DynamoDB errors are thrown as PersistenceError (fail closed)", async () => {
  for (const name of ["ProvisionedThroughputExceededException", "TimeoutError", "InternalServerError", "AccessDeniedException"]) {
    const quota = new DynamoDbGenerationQuota({ send: async () => { throw Object.assign(new Error("boom"), { name }); } }, "t");
    await assert.rejects(quota.reserve(reservation), (error: unknown) => (
      error instanceof PersistenceError && error.operation === "reserve-ai-generation-quota" && error.originalErrorName === name
    ));
  }
  const missingCounter = new DynamoDbGenerationQuota({ send: async () => ({}) }, "t");
  await assert.rejects(missingCounter.reserve(reservation), PersistenceError);
});

test("each call uses a fresh random reservation id by default", async () => {
  const ids: unknown[] = [];
  const quota = new DynamoDbGenerationQuota({
    send: async (command) => { ids.push((command as UpdateCommand).input.ExpressionAttributeValues?.[":reservationId"]); return { Attributes: { used: ids.length } }; },
  }, "t");
  await quota.reserve(reservation);
  await quota.reserve(reservation);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)));
});

/**
 * End-to-end through the REAL AWS SDK v3 retry middleware (no network): the
 * first HTTP attempt is applied by the fake service but answers 500, so the SDK
 * retries the identical request. The second attempt fails the condition and the
 * returned old item proves the reservation: one increment, outcome `reserved`.
 */
test("real SDK retry after an applied-but-failed attempt increments exactly once", async () => {
  const bodies: string[] = [];
  let used = 0;
  const reservations = new Set<string>();
  const respond = (statusCode: number, body: unknown) => ({
    response: {
      statusCode,
      headers: { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": `req-${bodies.length}` },
      body: new TextEncoder().encode(JSON.stringify(body)),
    },
  });
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 3,
    requestHandler: {
      handle: async (request: { body?: unknown }) => {
        const body = String(request.body);
        bodies.push(body);
        const input = JSON.parse(body) as { ExpressionAttributeValues: Record<string, { S?: string; N?: string }> };
        const id = input.ExpressionAttributeValues[":reservationId"].S ?? "";
        const limit = Number(input.ExpressionAttributeValues[":limit"].N);
        if (used >= limit || reservations.has(id)) {
          return respond(400, {
            __type: "com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException",
            message: "The conditional request failed",
            Item: { used: { N: String(used) }, reservations: { SS: [...reservations] } },
          });
        }
        used += 1;
        reservations.add(id);
        if (bodies.length === 1) {
          return respond(500, { __type: "com.amazonaws.dynamodb.v20120810#InternalServerError", message: "lost response" });
        }
        return respond(200, { Attributes: { used: { N: String(used) } } });
      },
    } as never,
  });
  const quota = new DynamoDbGenerationQuota(DynamoDBDocumentClient.from(client), "t");

  assert.deepEqual(await quota.reserve(reservation), { status: "reserved", used: 1 });
  assert.equal(bodies.length, 2, "the SDK retried once");
  assert.equal(bodies[0], bodies[1], "the retry resent the identical request (same reservation id)");
  assert.equal(used, 1);
});
