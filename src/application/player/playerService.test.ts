import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryPlayerRepository } from "../../infrastructure/repositories/InMemoryPlayerRepository.ts";
import { ApplicationError } from "../errors.ts";
import { PlayerService } from "./playerService.ts";

function makeService(): PlayerService {
  let counter = 0;
  return new PlayerService(
    new InMemoryPlayerRepository(),
    () => `id-${(counter += 1)}`,
    () => "2026-01-01T00:00:00.000Z",
  );
}

test("creates a valid player: trims the name, generates playerId, sets createdAt/updatedAt", async () => {
  const service = makeService();

  const player = await service.create({ name: "  Joaquín  ", age: 6 });

  assert.equal(player.playerId, "player-id-1");
  assert.equal(player.name, "Joaquín");
  assert.equal(player.age, 6);
  assert.equal(player.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(player.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("rejects a blank, missing, or excessively long name", async () => {
  const service = makeService();
  for (const name of ["", "   ", "x".repeat(51), undefined, 42]) {
    await assert.rejects(
      service.create({ name, age: 6 }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_PLAYER",
    );
  }
});

test("rejects a missing, non-integer, or out-of-range age", async () => {
  const service = makeService();
  for (const age of [undefined, "6", 6.5, 2, 100]) {
    await assert.rejects(
      service.create({ name: "Amelia", age }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_PLAYER_AGE",
    );
  }
});

test("accepts the boundary ages 3 and 99", async () => {
  const service = makeService();
  assert.equal((await service.create({ name: "Amelia", age: 3 })).age, 3);
  assert.equal((await service.create({ name: "Abuela", age: 99 })).age, 99);
});

test("lists players ordered by createdAt ascending", async () => {
  let clock = 0;
  const timestamps = ["2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
  const service = new PlayerService(new InMemoryPlayerRepository(), () => `id-${clock}`, () => timestamps[clock++]);

  const first = await service.create({ name: "First", age: 5 });
  const second = await service.create({ name: "Second", age: 6 });
  const third = await service.create({ name: "Third", age: 7 });

  const list = await service.list();
  assert.deepEqual(list.map((player) => player.playerId), [second.playerId, third.playerId, first.playerId]);
});

test("updates name and age but preserves playerId and createdAt", async () => {
  const service = makeService();
  const created = await service.create({ name: "Joaquín", age: 6 });

  const updated = await service.update({ playerId: created.playerId, name: "Joaquín Andrés", age: 7 });

  assert.equal(updated.playerId, created.playerId);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.name, "Joaquín Andrés");
  assert.equal(updated.age, 7);
});

test("update of an unknown player throws PLAYER_NOT_FOUND and does not create it", async () => {
  const service = makeService();
  await assert.rejects(
    service.update({ playerId: "missing", name: "X", age: 5 }),
    (error: unknown) => error instanceof ApplicationError && error.code === "PLAYER_NOT_FOUND",
  );
  assert.deepEqual(await service.list(), []);
});

test("deletes an existing player and rejects deleting it again", async () => {
  const service = makeService();
  const created = await service.create({ name: "Joaquín", age: 6 });

  await service.delete(created.playerId);

  assert.deepEqual(await service.list(), []);
  await assert.rejects(
    service.delete(created.playerId),
    (error: unknown) => error instanceof ApplicationError && error.code === "PLAYER_NOT_FOUND",
  );
});

test("getById returns the player, or throws PLAYER_NOT_FOUND for an unknown id", async () => {
  const service = makeService();
  const created = await service.create({ name: "Joaquín", age: 6 });

  assert.deepEqual(await service.getById(created.playerId), created);
  await assert.rejects(
    service.getById("missing"),
    (error: unknown) => error instanceof ApplicationError && error.code === "PLAYER_NOT_FOUND",
  );
});
