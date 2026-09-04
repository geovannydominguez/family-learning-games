import assert from "node:assert/strict";
import test from "node:test";

import { MockGameRepository } from "../../repositories/game/MockGameRepository.ts";
import { InMemoryGameSessionRepository } from "../../infrastructure/repositories/InMemoryGameSessionRepository.ts";
import { ApplicationError } from "../errors.ts";
import { GameSessionService } from "./gameSessionService.ts";

test("starts a ten-question session without exposing correct answers", async () => {
  const service = new GameSessionService(new MockGameRepository(), new InMemoryGameSessionRepository(), () => "session-1", () => 0);
  const session = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });

  assert.equal(session.id, "session-1");
  assert.equal(session.totalQuestions, 10);
  assert.equal(session.currentQuestionIndex, 0);
  assert.equal(session.currentQuestion?.answers.length, 4);
  assert.ok(session.currentQuestion?.answers.every((answer) => !("isCorrect" in answer)));
});

test("submits and advances in the backend while returning feedback", async () => {
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(new MockGameRepository(), sessions, () => "session-1", () => 0);
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
  const service = new GameSessionService(new MockGameRepository(), sessions, () => "session-1", () => 0);
  const started = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  const first = await sessions.findById(started.id);
  await service.answer(started.id, first!.questions[0].answers[0].id);
  await assert.rejects(sessions.update(started.id, { ...first!, revision: 1 }, 0), (error: unknown) => error instanceof ApplicationError && error.code === "SESSION_CONFLICT");
});

test("returns explicit application errors for unknown selections, sessions and invalid answers", async () => {
  const service = new GameSessionService(new MockGameRepository(), new InMemoryGameSessionRepository(), () => "session-1", () => 0);

  await assert.rejects(service.start({ playerId: "missing", categoryId: "animals", difficulty: "easy" }), (error: unknown) => error instanceof ApplicationError && error.code === "RESOURCE_NOT_FOUND");
  await assert.rejects(service.answer("missing", "answer"), (error: unknown) => error instanceof ApplicationError && error.code === "SESSION_NOT_FOUND");
  const session = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  await assert.rejects(service.answer(session.id, "missing"), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_REQUEST");
});

test("rejects an answer after a session is complete", async () => {
  const sessions = new InMemoryGameSessionRepository();
  const service = new GameSessionService(new MockGameRepository(), sessions, () => "session-1", () => 0);
  const started = await service.start({ playerId: "amelia", categoryId: "animals", difficulty: "easy" });
  for (let index = 0; index < 10; index += 1) {
    const stored = await sessions.findById(started.id);
    await service.answer(started.id, stored!.questions[index].answers[0].id);
  }
  await assert.rejects(service.answer(started.id, "anything"), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_SESSION_STATE");
});
