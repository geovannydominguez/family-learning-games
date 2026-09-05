import assert from "node:assert/strict";
import test from "node:test";

import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import { createGameSession } from "../../application/game/gameSession.ts";
import type { Category, GameSession, Player, Question } from "../../domain/game/types.ts";
import { DynamoDbGameSessionRepository } from "./DynamoDbGameSessionRepository.ts";

const player: Player = { id: "p", name: "Player", avatar: "P", age: 8 };
const category: Category = { id: "animals", name: "Animals", description: "", icon: "A" };
const questions: Question[] = Array.from({ length: 10 }, (_, index) => ({ id: `q${index}`, categoryId: "animals", difficulty: "easy", text: "Q", answers: [{ id: `a${index}`, text: "A", isCorrect: true }] }));
const session = createGameSession({ gameId: "ai-animals-1", player, category, difficulty: "easy", questions, random: () => 0 });

test("creates conditionally, reads consistently and updates by expected revision", async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof GetCommand) return { Item: { sessionId: "s", ...session } };
    return {};
  } };
  const repository = new DynamoDbGameSessionRepository(client, "Sessions", () => "2026-09-01T00:00:00.000Z");
  await repository.create("s", session);
  assert.deepEqual(await repository.findById("s"), session);
  await repository.update("s", { ...session, revision: 1, score: 1 }, 0);

  const create = commands.find((command) => command instanceof PutCommand) as PutCommand;
  assert.equal(create.input.ConditionExpression, "attribute_not_exists(sessionId)");
  assert.equal(create.input.Item?.gameId, "ai-animals-1");
  const get = commands.find((command) => command instanceof GetCommand) as GetCommand;
  assert.equal(get.input.ConsistentRead, true);
  const update = commands.find((command) => command instanceof UpdateCommand) as UpdateCommand;
  assert.equal(update.input.ConditionExpression, "#revision = :expectedRevision");
  assert.equal(update.input.ExpressionAttributeValues?.[":expectedRevision"], 0);
  assert.equal(update.input.ExpressionAttributeValues?.[":gameId"], "ai-animals-1");
});

test("loads legacy session records by falling back to the category id", async () => {
  const legacySession = { ...session } as Partial<GameSession>;
  delete legacySession.gameId;
  const repository = new DynamoDbGameSessionRepository({
    send: async () => ({ Item: { sessionId: "legacy", ...legacySession } }),
  }, "Sessions");

  assert.equal((await repository.findById("legacy"))?.gameId, "animals");
});

test("rejects persisted sessions whose player omits a valid mandatory age without leaking record data", async () => {
  for (const invalidPlayer of [
    { id: "p", name: "Player", avatar: "P" },
    { ...player, age: 0 },
    { ...player, age: 4.5 },
  ]) {
    const repository = new DynamoDbGameSessionRepository({
      send: async () => ({ Item: { sessionId: "session-secret", ...session, player: invalidPlayer } }),
    }, "Sessions");

    await assert.rejects(repository.findById("s"), (error: unknown) => (
      error instanceof Error
      && error.message === "DynamoDB returned an invalid game session record."
      && !error.message.includes("session-secret")
    ));
  }
});

test("translates conditional failures into SESSION_CONFLICT", async () => {
  const error = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
  const repository = new DynamoDbGameSessionRepository({ send: async () => { throw error; } }, "Sessions");
  await assert.rejects(repository.update("s", { ...session, revision: 1 }, 0), (caught: unknown) => caught instanceof ApplicationError && caught.code === "SESSION_CONFLICT" && !caught.message.includes("conditional"));
});

test("persists completedAt and rejects a duplicate stale final-answer update", async () => {
  const commands: UpdateCommand[] = [];
  const conditionalFailure = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
  const client = { send: async (command: unknown) => {
    assert.ok(command instanceof UpdateCommand);
    commands.push(command);
    if (commands.length === 2) throw conditionalFailure;
    return {};
  } };
  const repository = new DynamoDbGameSessionRepository(client, "Sessions", () => "2026-09-01T01:02:03.000Z");
  const completed = { ...session, revision: 1, currentQuestionIndex: 9, status: "completed" as const };

  await repository.update("s", completed, 0);
  assert.equal(commands[0].input.ExpressionAttributeValues?.[":completedAt"], "2026-09-01T01:02:03.000Z");
  assert.equal(commands[0].input.ExpressionAttributeValues?.[":revision"], 1);
  await assert.rejects(repository.update("s", completed, 0), (caught: unknown) => caught instanceof ApplicationError && caught.code === "SESSION_CONFLICT");
});

test("translates an unknown session client failure and omits an unsafe resource id", async () => {
  const transportFailure = Object.assign(new Error("secret socket and request id"), { name: "UnknownTransportFailure" });
  const repository = new DynamoDbGameSessionRepository({ send: async () => { throw transportFailure; } }, "Sessions");

  await assert.rejects(repository.findById("unsafe/session\nvalue"), (caught: unknown) => {
    assert.ok(caught instanceof PersistenceError);
    assert.equal(caught.operation, "get-game-session");
    assert.equal(caught.resourceId, undefined);
    assert.equal(caught.originalErrorName, "UnknownTransportFailure");
    assert.equal(caught.message.includes("secret"), false);
    return true;
  });
});
