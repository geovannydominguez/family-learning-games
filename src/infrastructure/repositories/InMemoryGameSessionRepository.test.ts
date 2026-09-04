import assert from "node:assert/strict";
import test from "node:test";

import { createGameSession } from "../../application/game/gameSession.ts";
import type { Category, Player, Question } from "../../domain/game/types.ts";
import { InMemoryGameSessionRepository } from "./InMemoryGameSessionRepository.ts";

const player: Player = { id: "p", name: "Player", avatar: "P" };
const category: Category = { id: "c", name: "Category", description: "", icon: "C" };
const questions: Question[] = Array.from({ length: 10 }, (_, index) => ({ id: `q${index}`, categoryId: "c", difficulty: "easy", text: "Question", answers: [{ id: `a${index}`, text: "Answer", isCorrect: true }] }));

test("stores, replaces and retrieves sessions by id", async () => {
  const repository = new InMemoryGameSessionRepository();
  const session = createGameSession({ player, category, difficulty: "easy", questions, random: () => 0 });
  await repository.create("one", session);
  assert.deepEqual(await repository.findById("one"), session);
  await repository.update("one", { ...session, score: 2, revision: 1 }, 0);
  assert.equal((await repository.findById("one"))?.score, 2);
  assert.equal(await repository.findById("missing"), null);
});
