import assert from "node:assert/strict";
import test from "node:test";

import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { PersistenceError } from "../../application/errors.ts";
import { DynamoDbGameRepository } from "./DynamoDbGameRepository.ts";

const gameItem = {
  gameId: "animals",
  title: "Animales",
  category: { id: "animals", name: "Animales", description: "", icon: "🐼" },
  players: [{ id: "p", name: "Player", avatar: "P" }],
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
