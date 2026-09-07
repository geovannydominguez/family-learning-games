import assert from "node:assert/strict";
import test from "node:test";

import type { PublicGame } from "../../application/game/gameSessionContracts.ts";
import { GameApiError } from "../../infrastructure/http/GameApiClient.ts";
import {
  buildCreatedGameSessionCommand,
  buildStartSessionCommand,
  createdGameDifficulty,
  gameUiErrorMessage,
  selectCreatedGames,
} from "./gameUiState.ts";

function publicGame(overrides: Partial<PublicGame> = {}): PublicGame {
  return {
    id: "ai-abc",
    title: "Pokémon",
    category: { id: "pokemon", name: "Pokémon", description: "Juego IA", icon: "🎮" },
    difficulties: ["hard"],
    questions: [],
    ...overrides,
  };
}

test("builds backward-compatible seeded and exact generated session commands", () => {
  assert.deepEqual(buildStartSessionCommand("player", "animals", "easy"), {
    playerId: "player",
    categoryId: "animals",
    difficulty: "easy",
  });
  assert.deepEqual(buildStartSessionCommand("player", "animals", "easy", "ai-animals-1"), {
    playerId: "player",
    categoryId: "animals",
    difficulty: "easy",
    gameId: "ai-animals-1",
  });
});

test("maps generation failures to friendly UI messages without provider details", () => {
  const cases: Array<{ error: unknown; expected: RegExp }> = [
    { error: new GameApiError("RATE_LIMITED", "raw", 429), expected: /muchas familias/i },
    { error: new GameApiError("API_ERROR", "raw", 429), expected: /muchas familias/i },
    { error: new GameApiError("AI_GENERATION_DISABLED", "raw", 503), expected: /no está disponible/i },
    { error: new GameApiError("INVALID_GENERATION_REQUEST", "raw", 400), expected: /tema válido/i },
    { error: new GameApiError("AI_GENERATED_CONTENT_INVALID", "raw", 422), expected: /contenido válido/i },
    { error: new GameApiError("AI_GENERATION_FAILED", "provider secret", 502), expected: /crear el juego/i },
    { error: new GameApiError("AI_GENERATION_BLOCKED", "blocked by content safety rules", 422), expected: /prueba con otro tema/i },
  ];

  for (const scenario of cases) {
    const message = gameUiErrorMessage(scenario.error, "Fallback");
    assert.match(message, scenario.expected);
    assert.equal(message.includes("raw"), false);
    assert.equal(message.includes("provider secret"), false);
  }
});

test("selectCreatedGames keeps only ai-* games and never seed/base games", () => {
  const catalog: PublicGame[] = [
    publicGame({ id: "animals", category: { id: "animals", name: "Animales", description: "", icon: "🐼" } }),
    publicGame({ id: "space", category: { id: "space", name: "Espacio", description: "", icon: "🚀" } }),
    publicGame({ id: "numbers", category: { id: "numbers", name: "Números", description: "", icon: "🔢" } }),
    publicGame({ id: "ai-uuid-1", title: "Pokémon" }),
    publicGame({ id: "ai-uuid-2", title: "Adivina el Número", category: { id: "adivina-el-numero", name: "Adivina el Número", description: "", icon: "🔢" } }),
  ];

  const created = selectCreatedGames(catalog);

  assert.deepEqual(created.map((game) => game.id), ["ai-uuid-1", "ai-uuid-2"]);
  assert.equal(created.some((game) => ["animals", "space", "numbers"].includes(game.id)), false);
});

test("selectCreatedGames tolerates a missing or malformed catalog so the section can stay hidden", () => {
  assert.deepEqual(selectCreatedGames(null), []);
  assert.deepEqual(selectCreatedGames(undefined), []);
  assert.deepEqual(selectCreatedGames([]), []);
  assert.deepEqual(selectCreatedGames([{ id: 123 } as unknown as PublicGame]), []);
  assert.deepEqual(selectCreatedGames(selectCreatedGames([])), []);
});

test("createdGameDifficulty uses the game's single difficulty and falls back defensively", () => {
  assert.equal(createdGameDifficulty(publicGame({ difficulties: ["hard"] })), "hard");
  assert.equal(createdGameDifficulty(publicGame({ difficulties: ["easy"] })), "easy");
  assert.equal(createdGameDifficulty(publicGame({ difficulties: [] })), "normal");
});

test("buildCreatedGameSessionCommand replays a persisted ai game by its exact gameId, never legacy category lookup", () => {
  const game = publicGame({
    id: "ai-2f9c",
    title: "Pokémon",
    category: { id: "pokemon", name: "Pokémon", description: "Juego IA", icon: "🎮" },
    difficulties: ["hard"],
  });

  const command = buildCreatedGameSessionCommand("joaquin", game);

  assert.deepEqual(command, {
    playerId: "joaquin",
    categoryId: "pokemon",
    gameId: "ai-2f9c",
    difficulty: "hard",
  });
  // gameId present -> backend selects the stored game by id; categoryId is the
  // game's own slug, not one of the base categories.
  assert.equal(command.gameId, game.id);
  assert.equal(["animals", "space", "numbers"].includes(command.categoryId), false);
});
