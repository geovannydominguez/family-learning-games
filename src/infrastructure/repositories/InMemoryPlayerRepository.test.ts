import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../../application/errors.ts";
import type { Player } from "../../domain/player/types.ts";
import { InMemoryPlayerRepository } from "./InMemoryPlayerRepository.ts";

function player(overrides: Partial<Player> = {}): Player {
  return {
    playerId: "amelia",
    name: "Amelia",
    age: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("creates and retrieves a player by id", async () => {
  const repository = new InMemoryPlayerRepository();
  await repository.create(player());
  assert.deepEqual(await repository.getById("amelia"), player());
});

test("getById returns null for an unknown player", async () => {
  const repository = new InMemoryPlayerRepository();
  assert.equal(await repository.getById("missing"), null);
});

test("rejects creating a player whose id already exists", async () => {
  const repository = new InMemoryPlayerRepository();
  await repository.create(player());
  await assert.rejects(
    repository.create(player({ name: "Duplicate" })),
    (error: unknown) => error instanceof ApplicationError && error.code === "PLAYER_CONFLICT",
  );
});

test("lists players ordered by createdAt ascending", async () => {
  const repository = new InMemoryPlayerRepository();
  await repository.create(player({ playerId: "b", createdAt: "2026-01-02T00:00:00.000Z" }));
  await repository.create(player({ playerId: "a", createdAt: "2026-01-01T00:00:00.000Z" }));

  assert.deepEqual((await repository.list()).map((candidate) => candidate.playerId), ["a", "b"]);
});

test("updates an existing player in place", async () => {
  const repository = new InMemoryPlayerRepository();
  await repository.create(player());

  const updated = await repository.update(player({ name: "Amelia Rose", age: 5, updatedAt: "2026-02-01T00:00:00.000Z" }));

  assert.deepEqual(updated, await repository.getById("amelia"));
  assert.equal(updated.name, "Amelia Rose");
});

test("deletes a player", async () => {
  const repository = new InMemoryPlayerRepository();
  await repository.create(player());

  await repository.delete("amelia");

  assert.equal(await repository.getById("amelia"), null);
});
