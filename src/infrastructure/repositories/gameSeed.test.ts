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

test("v0.8: seed questions may carry a logical image reference, but never an invalid one", () => {
  const source = gameData as GameSeedSource;
  const [first, ...rest] = source.questions;
  const withImage = { ...first, media: { image: { assetId: "animals/cat-01", altText: "Un gato" } } };
  const [record] = buildGameSeedRecords({ ...source, questions: [withImage, ...rest] });
  assert.deepEqual(record.questions.find((question) => question.id === first.id)?.media, withImage.media);

  for (const image of [{ assetId: "https://cdn.example/cat.png", altText: "Un gato" }, { assetId: "animals/cat-01", altText: "" }]) {
    assert.throws(
      () => buildGameSeedRecords({ ...source, questions: [{ ...first, media: { image } }, ...rest] }),
      /invalid image metadata/,
    );
  }
});
