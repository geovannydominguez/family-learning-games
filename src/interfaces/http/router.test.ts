import assert from "node:assert/strict";
import test from "node:test";

import { GameSessionService } from "../../application/game/gameSessionService.ts";
import { InMemoryGameSessionRepository } from "../../infrastructure/repositories/InMemoryGameSessionRepository.ts";
import { MockGameRepository } from "../../repositories/game/MockGameRepository.ts";
import { createHttpRouter } from "./router.ts";

function createFixture(log: (record: unknown) => void = () => {}) {
  const games = new MockGameRepository();
  const sessions = new InMemoryGameSessionRepository();
  return { router: createHttpRouter({ games, sessionService: new GameSessionService(games, sessions, () => "session-1", () => 0), log }), sessions };
}

test("GET /game-setup exposes selections but no questions", async () => {
  const { router } = createFixture();
  const response = await router({ requestId: "r1", method: "GET", path: "/game-setup" });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.difficulties, ["easy", "normal", "hard"]);
  assert.equal("questions" in body, false);
});

test("start and answer routes use JSON contracts and keep answer keys secret", async () => {
  const { router, sessions } = createFixture();
  const start = await router({ requestId: "r1", method: "POST", path: "/game-sessions", body: JSON.stringify({ playerId: "amelia", categoryId: "animals", difficulty: "easy" }) });
  assert.equal(start.statusCode, 201);
  const started = JSON.parse(start.body);
  assert.equal(started.currentQuestion.answers.some((answer: object) => "isCorrect" in answer), false);
  const stored = await sessions.findById("session-1");
  const answerId = stored!.questions[0].answers[0].id;
  const answer = await router({ requestId: "r2", method: "POST", path: "/game-sessions/session-1/answers", body: JSON.stringify({ answerId }) });
  assert.equal(answer.statusCode, 200);
  assert.equal(JSON.parse(answer.body).nextSession.currentQuestionIndex, 1);
});

test("maps malformed JSON, missing sessions, invalid state and unknown routes", async () => {
  const { router, sessions } = createFixture();
  const malformed = await router({ requestId: "r", method: "POST", path: "/game-sessions", body: "{" });
  assert.deepEqual(JSON.parse(malformed.body), { error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON." } });
  assert.equal(malformed.statusCode, 400);
  const missing = await router({ requestId: "r", method: "POST", path: "/game-sessions/missing/answers", body: JSON.stringify({ answerId: "a" }) });
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).error.code, "SESSION_NOT_FOUND");
  const route = await router({ requestId: "r", method: "GET", path: "/missing" });
  assert.equal(route.statusCode, 404);

  await router({ requestId: "r", method: "POST", path: "/game-sessions", body: JSON.stringify({ playerId: "amelia", categoryId: "animals", difficulty: "easy" }) });
  for (let index = 0; index < 10; index += 1) {
    const stored = await sessions.findById("session-1");
    await router({ requestId: "r", method: "POST", path: "/game-sessions/session-1/answers", body: JSON.stringify({ answerId: stored!.questions[index].answers[0].id }) });
  }
  const completed = await router({ requestId: "r", method: "POST", path: "/game-sessions/session-1/answers", body: JSON.stringify({ answerId: "answer" }) });
  assert.equal(completed.statusCode, 409);
  assert.equal(JSON.parse(completed.body).error.code, "INVALID_SESSION_STATE");
});

test("returns safe 500 errors and one structured log per request", async () => {
  const logs: unknown[] = [];
  const games = { getPlayers: async () => { throw new Error("secret stack"); }, getCategories: async () => [], getQuestions: async () => [] };
  const router = createHttpRouter({ games, sessionService: {} as GameSessionService, log: (record) => logs.push(record) });
  const response = await router({ requestId: "req", method: "GET", path: "/game-setup" });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes("secret stack"), false);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0] as object).sort(), ["durationMs", "level", "method", "path", "requestId", "statusCode", "timestamp"].sort());
});
