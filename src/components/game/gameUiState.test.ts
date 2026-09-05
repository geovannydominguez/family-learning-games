import assert from "node:assert/strict";
import test from "node:test";

import { GameApiError } from "../../infrastructure/http/GameApiClient.ts";
import {
  buildStartSessionCommand,
  gameUiErrorMessage,
} from "./gameUiState.ts";

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
  ];

  for (const scenario of cases) {
    const message = gameUiErrorMessage(scenario.error, "Fallback");
    assert.match(message, scenario.expected);
    assert.equal(message.includes("raw"), false);
    assert.equal(message.includes("provider secret"), false);
  }
});
