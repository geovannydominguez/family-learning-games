import assert from "node:assert/strict";
import test from "node:test";

import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import type { Player } from "../../domain/player/types.ts";
import { DynamoDbPlayerRepository } from "./DynamoDbPlayerRepository.ts";

const playerItem: Player = {
  playerId: "amelia",
  name: "Amelia",
  age: 4,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

test("maps DynamoDB player records for get and list", async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => {
    commands.push(command);
    if (command instanceof ScanCommand) return { Items: [playerItem] };
    if (command instanceof GetCommand) return { Item: playerItem };
    throw new Error("unexpected command");
  } };
  const repository = new DynamoDbPlayerRepository(client, "Players");

  assert.deepEqual(await repository.list(), [playerItem]);
  assert.deepEqual(await repository.getById("amelia"), playerItem);
  assert.ok(commands.some((command) => command instanceof ScanCommand));
  assert.ok(commands.some((command) => command instanceof GetCommand));
});

test("list sorts by createdAt ascending and paginates the scan", async () => {
  const second: Player = { ...playerItem, playerId: "joaquin", createdAt: "2026-09-02T00:00:00.000Z" };
  const scans: ScanCommand[] = [];
  const repository = new DynamoDbPlayerRepository({
    send: async (command: object) => {
      assert.ok(command instanceof ScanCommand);
      scans.push(command);
      return command.input.ExclusiveStartKey
        ? { Items: [second] }
        : { Items: [playerItem], LastEvaluatedKey: { playerId: "amelia" } };
    },
  }, "Players");

  const list = await repository.list();

  assert.deepEqual(list.map((player) => player.playerId), ["amelia", "joaquin"]);
  assert.deepEqual(scans[1].input.ExclusiveStartKey, { playerId: "amelia" });
});

test("getById returns null for an unknown player", async () => {
  const repository = new DynamoDbPlayerRepository({ send: async () => ({}) }, "Players");
  assert.equal(await repository.getById("missing"), null);
});

test("rejects a malformed persisted player record without leaking a partial model", async () => {
  const repository = new DynamoDbPlayerRepository({ send: async () => ({ Item: { playerId: "broken" } }) }, "Players");
  await assert.rejects(repository.getById("broken"), /invalid player record/i);
});

test("creates a player with a conditional put and translates a collision into PLAYER_CONFLICT", async () => {
  const commands: unknown[] = [];
  const repository = new DynamoDbPlayerRepository({
    send: async (command: unknown) => { commands.push(command); return {}; },
  }, "Players");

  await repository.create(playerItem);

  const put = commands.find((command) => command instanceof PutCommand) as PutCommand;
  assert.equal(put.input.ConditionExpression, "attribute_not_exists(playerId)");
  assert.deepEqual(put.input.Item, playerItem);

  const collision = Object.assign(new Error("conditional detail"), { name: "ConditionalCheckFailedException" });
  const conflicting = new DynamoDbPlayerRepository({ send: async () => { throw collision; } }, "Players");
  await assert.rejects(
    conflicting.create(playerItem),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "PLAYER_CONFLICT"
      && !error.message.includes("conditional"),
  );
});

test("updates a player conditionally and translates a missing record into PLAYER_NOT_FOUND", async () => {
  const commands: unknown[] = [];
  const repository = new DynamoDbPlayerRepository({
    send: async (command: unknown) => { commands.push(command); return {}; },
  }, "Players");

  const updated = { ...playerItem, name: "Amelia Rose", age: 5, updatedAt: "2026-09-05T00:00:00.000Z" };
  await repository.update(updated);

  const update = commands.find((command) => command instanceof UpdateCommand) as UpdateCommand;
  assert.equal(update.input.ConditionExpression, "attribute_exists(playerId)");
  assert.equal(update.input.ExpressionAttributeValues?.[":name"], "Amelia Rose");

  const missing = Object.assign(new Error("conditional detail"), { name: "ConditionalCheckFailedException" });
  const repositoryMissing = new DynamoDbPlayerRepository({ send: async () => { throw missing; } }, "Players");
  await assert.rejects(
    repositoryMissing.update(playerItem),
    (error: unknown) => error instanceof ApplicationError && error.code === "PLAYER_NOT_FOUND",
  );
});

test("deletes a player", async () => {
  const commands: unknown[] = [];
  const repository = new DynamoDbPlayerRepository({
    send: async (command: unknown) => { commands.push(command); return {}; },
  }, "Players");

  await repository.delete("amelia");

  const del = commands.find((command) => command instanceof DeleteCommand) as DeleteCommand;
  assert.deepEqual(del.input.Key, { playerId: "amelia" });
});

test("translates an unknown client failure into a sanitized persistence error", async () => {
  const transportFailure = Object.assign(new Error("secret endpoint and credentials"), {
    name: "NewDynamoTransportFault",
    $metadata: { requestId: "secret-request" },
  });
  const repository = new DynamoDbPlayerRepository({ send: async () => { throw transportFailure; } }, "Players");

  await assert.rejects(repository.getById("amelia"), (caught: unknown) => {
    assert.ok(caught instanceof PersistenceError);
    assert.equal(caught.operation, "get-player");
    assert.equal(caught.resourceId, "amelia");
    assert.equal(caught.originalErrorName, "NewDynamoTransportFault");
    assert.equal(JSON.stringify(caught).includes("secret"), false);
    return true;
  });
});
