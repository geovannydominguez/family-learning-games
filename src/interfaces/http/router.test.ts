import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import type { GenerateGameService } from "../../application/game/generateGameService.ts";
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

test("lists persisted games, gets one game and retrieves a durable session", async () => {
  const { router } = createFixture();
  const list = await router({ requestId: "r", method: "GET", path: "/games" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(JSON.parse(list.body).map((game: { id: string }) => game.id), ["animals", "space", "numbers"]);
  assert.equal(list.body.includes("isCorrect"), false);

  const game = await router({ requestId: "r", method: "GET", path: "/games/animals" });
  assert.equal(game.statusCode, 200);
  assert.equal(JSON.parse(game.body).id, "animals");
  assert.equal(game.body.includes("isCorrect"), false);

  await router({ requestId: "r", method: "POST", path: "/game-sessions", body: JSON.stringify({ playerId: "amelia", categoryId: "animals", difficulty: "easy" }) });
  const session = await router({ requestId: "r", method: "GET", path: "/game-sessions/session-1" });
  assert.equal(session.statusCode, 200);
  assert.equal(JSON.parse(session.body).id, "session-1");
  assert.equal(session.body.includes("isCorrect"), false);
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

test("accepts optional gameId when starting a session", async () => {
  const games = new MockGameRepository();
  const base = await games.findById("animals");
  assert.ok(base);
  await games.create({ ...base, id: "ai-animals-1" });
  const sessions = new InMemoryGameSessionRepository();
  const router = createHttpRouter({
    games,
    sessionService: new GameSessionService(games, sessions, () => "session-ai", () => 0),
    log: () => {},
  });

  const response = await router({
    requestId: "r-ai",
    method: "POST",
    path: "/game-sessions",
    body: JSON.stringify({ playerId: "amelia", categoryId: "animals", gameId: "ai-animals-1", difficulty: "easy" }),
  });

  assert.equal(response.statusCode, 201);
  assert.equal((await sessions.findById("session-ai"))?.gameId, "ai-animals-1");
});

test("GET /games lists ai-generated games with the public shape and no answer keys", async () => {
  const games = new MockGameRepository();
  const base = await games.findById("animals");
  assert.ok(base);
  await games.create({
    ...base,
    id: "ai-pokemon-1",
    title: "Pokémon",
    category: { id: "pokemon", name: "Pokémon", description: "Juego IA de Pokémon.", icon: "🎮" },
    questions: base.questions.filter((question) => question.difficulty === "hard").map((question) => ({ ...question, categoryId: "pokemon" })),
  });
  const router = createHttpRouter({
    games,
    sessionService: new GameSessionService(games, new InMemoryGameSessionRepository()),
    log: () => {},
  });

  const response = await router({ requestId: "r", method: "GET", path: "/games" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes("isCorrect"), false);
  const list = JSON.parse(response.body) as Array<{ id: string; title: string; category: Record<string, string>; difficulties: string[] }>;
  assert.deepEqual(list.map((game) => game.id), ["animals", "space", "numbers", "ai-pokemon-1"]);
  const created = list.find((game) => game.id === "ai-pokemon-1");
  assert.ok(created);
  assert.equal(created.title, "Pokémon");
  assert.deepEqual(Object.keys(created.category).sort(), ["description", "icon", "id", "name"]);
  assert.deepEqual(created.difficulties, ["hard"]);
});

test("starts a session for a persisted ai game by its exact gameId and slug category without generating", async () => {
  const games = new MockGameRepository();
  const base = await games.findById("animals");
  assert.ok(base);
  await games.create({
    ...base,
    id: "ai-pokemon-1",
    title: "Pokémon",
    category: { id: "pokemon", name: "Pokémon", description: "Juego IA de Pokémon.", icon: "🎮" },
    questions: base.questions.filter((question) => question.difficulty === "hard").map((question) => ({ ...question, categoryId: "pokemon" })),
  });
  const sessions = new InMemoryGameSessionRepository();
  const generationService = { generate: async () => { throw new Error("must not generate"); } } as unknown as GenerateGameService;
  const router = createHttpRouter({
    games,
    sessionService: new GameSessionService(games, sessions, () => "session-poke", () => 0),
    generationService,
    log: () => {},
  });

  const response = await router({
    requestId: "r-poke",
    method: "POST",
    path: "/game-sessions",
    body: JSON.stringify({ playerId: "papa", categoryId: "pokemon", gameId: "ai-pokemon-1", difficulty: "hard" }),
  });

  assert.equal(response.statusCode, 201);
  const stored = await sessions.findById("session-poke");
  assert.equal(stored?.gameId, "ai-pokemon-1");
  assert.equal(stored?.player.id, "papa");
});

test("POST /games/generate returns the existing public game shape without answer keys", async () => {
  const games = new MockGameRepository();
  const generated = await games.findById("animals");
  assert.ok(generated);
  const commands: unknown[] = [];
  const generationService = { generate: async (command: unknown) => {
    commands.push(command);
    return { ...generated, id: "ai-animals-1" };
  } } as unknown as GenerateGameService;
  const router = createHttpRouter({
    games,
    sessionService: new GameSessionService(games, new InMemoryGameSessionRepository()),
    generationService,
    log: () => {},
  });

  const response = await router({
    requestId: "generate-1",
    method: "POST",
    path: "/games/generate",
    body: JSON.stringify({ topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).id, "ai-animals-1");
  assert.equal(response.body.includes("isCorrect"), false);
  assert.deepEqual(commands, [{ topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia", correlationId: "generate-1" }]);
});

test("POST /games/generate maps generation errors to safe status contracts", async () => {
  const scenarios: Array<{ error: Error; status: number; code: string }> = [
    { error: new ApplicationError("INVALID_GENERATION_REQUEST", "Generation request is invalid."), status: 400, code: "INVALID_GENERATION_REQUEST" },
    { error: new ApplicationError("AI_GENERATION_DISABLED", "AI game generation is disabled."), status: 503, code: "AI_GENERATION_DISABLED" },
    { error: new ApplicationError("AI_GENERATED_CONTENT_INVALID", "Generated content is invalid."), status: 422, code: "AI_GENERATED_CONTENT_INVALID" },
    { error: new ApplicationError("AI_GENERATION_FAILED", "AI game generation failed."), status: 502, code: "AI_GENERATION_FAILED" },
    { error: new ApplicationError("GAME_ID_CONFLICT", "Game identity already exists."), status: 409, code: "GAME_ID_CONFLICT" },
    { error: new PersistenceError("create-game", new Error("secret provider detail"), "ai-safe"), status: 500, code: "UNEXPECTED_ERROR" },
  ];

  for (const scenario of scenarios) {
    const games = new MockGameRepository();
    const generationService = { generate: async () => { throw scenario.error; } } as unknown as GenerateGameService;
    const router = createHttpRouter({
      games,
      sessionService: new GameSessionService(games, new InMemoryGameSessionRepository()),
      generationService,
      log: () => {},
    });
    const response = await router({
      requestId: "generate-error",
      method: "POST",
      path: "/games/generate",
      body: JSON.stringify({ topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
    });

    assert.equal(response.statusCode, scenario.status);
    assert.equal(JSON.parse(response.body).error.code, scenario.code);
    assert.equal(response.body.includes("secret"), false);
  }
});

test("POST /games/generate safely rejects malformed request JSON", async () => {
  const games = new MockGameRepository();
  const generationService = { generate: async () => { throw new Error("must not run"); } } as unknown as GenerateGameService;
  const router = createHttpRouter({
    games,
    sessionService: new GameSessionService(games, new InMemoryGameSessionRepository()),
    generationService,
    log: () => {},
  });

  const response = await router({ requestId: "bad-json", method: "POST", path: "/games/generate", body: "{" });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "INVALID_GENERATION_REQUEST");
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
  const persisted = await router({ requestId: "r", method: "GET", path: "/game-sessions/session-1" });
  assert.equal(JSON.parse(persisted.body).status, "completed");
  const completed = await router({ requestId: "r", method: "POST", path: "/game-sessions/session-1/answers", body: JSON.stringify({ answerId: "answer" }) });
  assert.equal(completed.statusCode, 409);
  assert.equal(JSON.parse(completed.body).error.code, "INVALID_SESSION_STATE");
});

test("maps optimistic persistence conflicts to a safe 409 response", async () => {
  const games = new MockGameRepository();
  const sessionService = { answer: async () => { throw new ApplicationError("SESSION_CONFLICT", "The game session changed before this request could be saved."); } } as unknown as GameSessionService;
  const router = createHttpRouter({ games, sessionService, log: () => {} });
  const response = await router({ requestId: "r", method: "POST", path: "/game-sessions/session/answers", body: JSON.stringify({ answerId: "answer" }) });
  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).error.code, "SESSION_CONFLICT");
});

test("returns safe 500 errors and one structured log per request", async () => {
  const logs: unknown[] = [];
  const games = { create: async () => {}, findAll: async () => [], findById: async () => null, getPlayers: async () => { throw new Error("secret stack"); }, getCategories: async () => [], getQuestions: async () => [] };
  const router = createHttpRouter({ games, sessionService: {} as GameSessionService, log: (record) => logs.push(record) });
  const response = await router({ requestId: "req", method: "GET", path: "/game-setup" });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes("secret stack"), false);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0] as object).sort(), ["durationMs", "error", "level", "method", "path", "requestId", "statusCode", "timestamp"].sort());
  assert.deepEqual((logs[0] as { error: unknown }).error, { category: "unexpected", name: "Error", operation: "get-game-setup" });
});

test("logs explicit sanitized persistence provenance while returning a generic 500", async () => {
  const logs: unknown[] = [];
  const persistenceFailure = new PersistenceError("get-game", Object.assign(new Error("secret SDK message and request id"), {
    name: "BrandNewTransportFailure",
    $metadata: { requestId: "secret-request-id" },
  }), "animals");
  const games = {
    create: async () => {},
    findAll: async () => [],
    findById: async () => { throw persistenceFailure; },
    getPlayers: async () => [],
    getCategories: async () => [],
    getQuestions: async () => [],
  };
  const router = createHttpRouter({ games, sessionService: {} as GameSessionService, log: (record) => logs.push(record) });

  const response = await router({ requestId: "request-1", method: "GET", path: "/games/animals" });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), { error: { code: "UNEXPECTED_ERROR", message: "An unexpected error occurred." } });
  const record = logs[0] as Record<string, unknown>;
  assert.deepEqual(record.error, {
    category: "persistence",
    name: "BrandNewTransportFailure",
    operation: "get-game",
    resourceId: "animals",
  });
  assert.equal(JSON.stringify(record).includes("secret"), false);
  assert.equal(JSON.stringify(record).includes("$metadata"), false);
});

test("does not classify expected conflicts as 500 persistence diagnostics", async () => {
  const logs: unknown[] = [];
  const games = new MockGameRepository();
  const sessionService = { answer: async () => { throw new ApplicationError("SESSION_CONFLICT", "Session changed."); } } as unknown as GameSessionService;
  const router = createHttpRouter({ games, sessionService, log: (record) => logs.push(record) });

  const response = await router({ requestId: "r", method: "POST", path: "/game-sessions/session/answers", body: JSON.stringify({ answerId: "answer" }) });

  assert.equal(response.statusCode, 409);
  assert.equal("error" in (logs[0] as object), false);
});

test("omits unsafe persistence resource identifiers from diagnostics", async () => {
  const logs: unknown[] = [];
  const failure = new PersistenceError("get-game", new Error("transport"), "unsafe/session\nvalue");
  const games = { create: async () => {}, findAll: async () => [], findById: async () => { throw failure; }, getPlayers: async () => [], getCategories: async () => [], getQuestions: async () => [] };
  const router = createHttpRouter({ games, sessionService: {} as GameSessionService, log: (record) => logs.push(record) });

  await router({ requestId: "r", method: "GET", path: "/games/animals" });

  assert.deepEqual((logs[0] as { error: unknown }).error, { category: "persistence", name: "Error", operation: "get-game" });
});
