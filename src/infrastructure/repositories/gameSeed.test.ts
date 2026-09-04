import assert from "node:assert/strict";
import test from "node:test";

import gameData from "../../data/games.json" with { type: "json" };
import { buildGameSeedRecords, type GameSeedSource } from "./gameSeed.ts";

test("builds deterministic category-backed game records from the existing fixture", () => {
  const first = buildGameSeedRecords(gameData as GameSeedSource);
  const second = buildGameSeedRecords(gameData as GameSeedSource);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((game) => game.gameId), ["animals", "space", "numbers"]);
  assert.equal(first.reduce((sum, game) => sum + game.questions.length, 0), 90);
  assert.ok(first.every((game) => game.players.length === 4 && game.version === 1));
});
