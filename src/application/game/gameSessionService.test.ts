import assert from "node:assert/strict";
import test from "node:test";

import { MockGameRepository } from "../../repositories/game/MockGameRepository.ts";
import type { Game } from "../../domain/game/types.ts";
import type { Player } from "../../domain/player/types.ts";
import { InMemoryGameSessionRepository } from "../../infrastructure/repositories/InMemoryGameSessionRepository.ts";
import { InMemoryPlayerRepository } from "../../infrastructure/repositories/InMemoryPlayerRepository.ts";
import { ApplicationError } from "../errors.ts";
import type { PlayerRepository } from "../player/PlayerRepository.ts";
import { GameSessionService } from "./gameSessionService.ts";

/** A `PlayerRepository` pre-seeded with one persistent family player, "amelia". */
async function playersWith(overrides: Partial<Player> = {}): Promise<PlayerRepository> {
  const repository = new InMemoryPlayerRepository();
  await repository.create({
    playerId: "amelia",
    name: "Amelia",
    age: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  return repository;
}

test("starts a ten-question session without exposing correct answers", async () => {
  const service = new GameSessionService(new MockGameRepository(), new InMemoryGameSessionRepository(), await playersWith(), () => "session-1", () => 0);
  const session = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });

  assert.equal(session.id, "session-1");
  assert.equal(session.totalQuestions, 10);
  assert.equal(session.currentQuestionIndex, 0);
  assert.equal(session.currentQuestion?.answers.length, 4);
  assert.ok(session.currentQuestion?.answers.every((answer) => !("isCorrect" in answer)));
});

test("resolves the player from PlayerRepository and records playerId on the new session", async () => {
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(new MockGameRepository(), sessions, await playersWith({ name: "Joaquín", age: 6 }), () => "session-1", () => 0);

  const session = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });

  assert.equal(session.playerId, "amelia");
  assert.equal(session.player.name, "Joaquín");
  assert.equal(session.player.age, 6);
  const stored = await sessions.findById(session.id);
  assert.equal(stored?.playerId, "amelia");
});

test("selects an exact gameId, persists it, and rejects a mismatched category", async () => {
  const games = new MockGameRepository();
  const base = await games.findById("animals");
  assert.ok(base);
  const generated: Game = {
    ...base,
    id: "ai-animals-1",
    title: "Generated animals",
  };
  await games.create(generated);
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(games, sessions, await playersWith(), () => "session-ai", () => 0);

  const started = await service.start({
    playerId: "amelia",
    categoryId: "animals",
    gameId: generated.id,
    difficulty: "easy",
  });

  assert.equal((await sessions.findById(started.id))?.gameId, generated.id);
  await assert.rejects(
    service.start({ playerId: "amelia", categoryId: "space", gameId: generated.id, difficulty: "easy" }),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    service.start({ playerId: "amelia", categoryId: "animals", gameId: "   ", difficulty: "easy" }),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_REQUEST",
  );
});

test("submits and advances in the backend while returning feedback", async () => {
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(new MockGameRepository(), sessions, await playersWith(), () => "session-1", () => 0);
  const started = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  const stored = await sessions.findById(started.id);
  const correct = stored!.questions[0].answers.find((answer) => answer.isCorrect)!;

  const result = await service.answer(started.id, correct.id);

  assert.equal(result.feedback.isCorrect, true);
  assert.equal(result.feedback.correctAnswerId, correct.id);
  assert.equal(result.nextSession.currentQuestionIndex, 1);
  assert.equal(result.nextSession.score, 1);
  assert.ok(result.nextSession.currentQuestion?.answers.every((answer) => !("isCorrect" in answer)));
  assert.deepEqual(await service.get(started.id), result.nextSession);
});

test("passes the loaded revision as the optimistic concurrency expectation", async () => {
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(new MockGameRepository(), sessions, await playersWith(), () => "session-1", () => 0);
  const started = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  const first = await sessions.findById(started.id);
  await service.answer(started.id, first!.questions[0].answers[0].id);
  await assert.rejects(sessions.update(started.id, { ...first!, revision: 1 }, 0), (error: unknown) => error instanceof ApplicationError && error.code === "SESSION_CONFLICT");
});

test("returns explicit application errors for unknown selections, sessions and invalid answers", async () => {
  const service = new GameSessionService(new MockGameRepository(), new InMemoryGameSessionRepository(), await playersWith(), () => "session-1", () => 0);

  await assert.rejects(service.start({ playerId: "missing", categoryId: "animals", difficulty: "easy" }), (error: unknown) => error instanceof ApplicationError && error.code === "RESOURCE_NOT_FOUND");
  await assert.rejects(service.answer("missing", "answer"), (error: unknown) => error instanceof ApplicationError && error.code === "SESSION_NOT_FOUND");
  const session = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  await assert.rejects(service.answer(session.id, "missing"), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_REQUEST");
});

test("rejects an answer after a session is complete", async () => {
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(new MockGameRepository(), sessions, await playersWith(), () => "session-1", () => 0);
  const started = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  for (let index = 0; index < 10; index += 1) {
    const stored = await sessions.findById(started.id);
    await service.answer(started.id, stored!.questions[index].answers[0].id);
  }
  await assert.rejects(service.answer(started.id, "anything"), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_SESSION_STATE");
});

test("a historical session created without playerId (pre-v0.6) can still be answered and read", async () => {
  const games = new MockGameRepository();
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(games, sessions, await playersWith(), () => "session-1", () => 0);
  const base = await games.findById("animals");
  assert.ok(base);
  const question = base.questions.find((candidate) => candidate.difficulty === "easy");
  assert.ok(question);
  const correct = question.answers.find((answer) => answer.isCorrect)!;

  // Simulate a pre-v0.6 record: no `playerId` field at all.
  await sessions.create("legacy-session", {
    gameId: base.id,
    revision: 0,
    player: { id: "amelia", name: "Amelia", avatar: "A", age: 4 },
    category: base.category,
    difficulty: "easy",
    questions: [question],
    currentQuestionIndex: 0,
    score: 0,
    answers: [],
    selectedAnswerId: null,
    status: "playing",
  });

  const fetched = await service.get("legacy-session");
  assert.equal(fetched.playerId, undefined);
  const answered = await service.answer("legacy-session", correct.id);
  assert.equal(answered.feedback.isCorrect, true);
});
