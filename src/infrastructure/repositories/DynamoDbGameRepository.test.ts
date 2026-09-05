import assert from "node:assert/strict";
import test from "node:test";

import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import { DynamoDbGameRepository } from "./DynamoDbGameRepository.ts";
import type { GameRecord } from "./gameSeed.ts";

const gameItem: GameRecord = {
  gameId: "animals",
  title: "Animales",
  category: { id: "animals", name: "Animales", description: "", icon: "🐼" },
  players: [{ id: "p", name: "Player", avatar: "P", age: 8 }],
  questions: [{ id: "q", categoryId: "animals", difficulty: "easy", text: "Q", answers: [{ id: "a", text: "A", isCorrect: true }] }],
  version: 1,
  sortOrder: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

test("maps DynamoDB game records and supports current setup access patterns", async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof ScanCommand) return { Items: [gameItem] };
    if (command instanceof GetCommand) return { Item: gameItem };
    throw new Error("unexpected command");
  } };
  const repository = new DynamoDbGameRepository(client, "Games");

  assert.deepEqual((await repository.findAll()).map((game) => game.id), ["animals"]);
  assert.equal((await repository.findById("animals"))?.category.id, "animals");
  assert.deepEqual(await repository.getPlayers(), gameItem.players);
  assert.deepEqual(await repository.getCategories(), [gameItem.category]);
  assert.equal((await repository.getQuestions({ categoryId: "animals", difficulty: "easy" })).length, 1);
  assert.ok(commands.some((command) => command instanceof ScanCommand));
  assert.ok(commands.some((command) => command instanceof GetCommand));
});

test("rejects persisted game records whose players omit the mandatory age", async () => {
  const invalidRecord = {
    ...gameItem,
    players: [{ id: "p", name: "Player", avatar: "P" }],
  };
  const repository = new DynamoDbGameRepository({
    send: async () => ({ Items: [invalidRecord] }),
  }, "Games");

  await assert.rejects(repository.findAll(), /invalid game record/);
});

test("creates games conditionally and deduplicates categories shared by multiple games", async () => {
  const commands: unknown[] = [];
  const generatedItem = { ...gameItem, gameId: "ai-animals-1", title: "Generated animals", sortOrder: 1 };
  const client = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof ScanCommand) return { Items: [gameItem, generatedItem] };
    return {};
  } };
  const repository = new DynamoDbGameRepository(client, "Games", () => "2026-09-04T00:00:00.000Z");

  await repository.create({
    id: generatedItem.gameId,
    title: generatedItem.title,
    category: generatedItem.category,
    players: generatedItem.players,
    questions: generatedItem.questions,
  });

  assert.deepEqual(await repository.getCategories(), [gameItem.category]);
  assert.equal((await repository.getQuestions({ categoryId: "animals" })).length, 2);
  const put = commands.find((command) => command instanceof PutCommand) as PutCommand;
  assert.equal(put.input.ConditionExpression, "attribute_not_exists(gameId)");
  assert.equal(put.input.Item?.gameId, generatedItem.gameId);
  assert.equal(put.input.Item?.createdAt, "2026-09-04T00:00:00.000Z");
});

test("keeps generated-only categories and players out of legacy game setup choices", async () => {
  const generatedOnlyItem: GameRecord = {
    ...gameItem,
    gameId: "ai-space-1",
    title: "Generated space",
    category: { id: "space", name: "Space", description: "Space", icon: "🚀" },
    players: [{ id: "generated-player", name: "Generated", avatar: "G", age: 8 }],
    questions: gameItem.questions.map((question) => ({ ...question, categoryId: "space" })),
  };
  const repository = new DynamoDbGameRepository({
    send: async (command: object) => command instanceof GetCommand
      ? { Item: generatedOnlyItem }
      : { Items: [gameItem, generatedOnlyItem] },
  }, "Games");

  assert.deepEqual(await repository.getCategories(), [gameItem.category]);
  assert.deepEqual(await repository.getPlayers(), gameItem.players);
  assert.deepEqual((await repository.findAll()).map((game) => game.id), ["animals", "ai-space-1"]);
  assert.equal((await repository.findById("ai-space-1"))?.id, "ai-space-1");
});

test("paginates scans for catalogs and legacy setup choices", async () => {
  const spaceItem: GameRecord = {
    ...gameItem,
    gameId: "space",
    title: "Space",
    category: { id: "space", name: "Space", description: "Space", icon: "🚀" },
    players: [{ id: "p2", name: "Player 2", avatar: "2", age: 8 }],
    questions: gameItem.questions.map((question) => ({ ...question, categoryId: "space" })),
    sortOrder: 1,
  };
  const scans: ScanCommand[] = [];
  const repository = new DynamoDbGameRepository({
    send: async (command: object) => {
      assert.ok(command instanceof ScanCommand);
      scans.push(command);
      return command.input.ExclusiveStartKey
        ? { Items: [spaceItem] }
        : { Items: [gameItem], LastEvaluatedKey: { gameId: "animals" } };
    },
  }, "Games");

  assert.deepEqual((await repository.findAll()).map((game) => game.id), ["animals", "space"]);
  assert.deepEqual((await repository.getCategories()).map((category) => category.id), ["animals", "space"]);
  assert.deepEqual((await repository.getPlayers()).map((player) => player.id), ["p", "p2"]);
  assert.deepEqual(scans[1].input.ExclusiveStartKey, { gameId: "animals" });
});

test("translates game create collisions without leaking DynamoDB details", async () => {
  const collision = Object.assign(new Error("conditional detail"), { name: "ConditionalCheckFailedException" });
  const repository = new DynamoDbGameRepository({ send: async () => { throw collision; } }, "Games");

  await assert.rejects(
    repository.create({
      id: "ai-animals-1",
      title: "Generated animals",
      category: gameItem.category,
      players: gameItem.players,
      questions: gameItem.questions,
    }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "GAME_ID_CONFLICT"
      && !error.message.includes("conditional"),
  );
});

test("translates an unknown game create failure into a sanitized persistence error", async () => {
  const failure = Object.assign(new Error("secret transport detail"), { name: "TransportFailure" });
  const repository = new DynamoDbGameRepository({ send: async () => { throw failure; } }, "Games");

  await assert.rejects(
    repository.create({
      id: "ai-animals-1",
      title: "Generated animals",
      category: gameItem.category,
      players: gameItem.players,
      questions: gameItem.questions,
    }),
    (error: unknown) => error instanceof PersistenceError
      && error.operation === "create-game"
      && error.resourceId === "ai-animals-1"
      && !error.message.includes("secret"),
  );
});

test("returns null for an unknown game and rejects malformed records without leaking a partial model", async () => {
  const missing = new DynamoDbGameRepository({ send: async () => ({}) }, "Games");
  assert.equal(await missing.findById("missing"), null);
  const malformed = new DynamoDbGameRepository({ send: async () => ({ Item: { gameId: "broken" } }) }, "Games");
  await assert.rejects(malformed.findById("broken"), /invalid game record/i);
});

test("translates an unknown client failure into a sanitized persistence error", async () => {
  const transportFailure = Object.assign(new Error("secret endpoint and credentials"), {
    name: "NewDynamoTransportFault",
    $metadata: { requestId: "secret-request" },
  });
  const repository = new DynamoDbGameRepository({ send: async () => { throw transportFailure; } }, "Games");

  await assert.rejects(repository.findById("animals"), (caught: unknown) => {
    assert.ok(caught instanceof PersistenceError);
    assert.equal(caught.operation, "get-game");
    assert.equal(caught.resourceId, "animals");
    assert.equal(caught.originalErrorName, "NewDynamoTransportFault");
    assert.equal(caught.message, "Persistence operation failed.");
    assert.equal("cause" in caught, false);
    assert.equal(JSON.stringify(caught).includes("secret"), false);
    return true;
  });
});
