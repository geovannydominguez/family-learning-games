import assert from "node:assert/strict";
import test from "node:test";

import { MockGameRepository } from "./MockGameRepository.ts";

test("the local dataset supports every v0.1 game combination", async () => {
  const repository = new MockGameRepository();
  const players = await repository.getPlayers();
  const categories = await repository.getCategories();
  const allQuestions = await repository.getQuestions();

  assert.deepEqual(
    players.map((player) => player.name),
    ["Amelia", "Joaquín", "Papá", "Mamá"],
  );
  assert.deepEqual(
    categories.map((category) => category.id),
    ["animals", "space", "numbers"],
  );
  assert.equal(new Set(players.map((player) => player.id)).size, players.length);
  assert.equal(
    new Set(categories.map((category) => category.id)).size,
    categories.length,
  );
  assert.equal(
    new Set(allQuestions.map((question) => question.id)).size,
    allQuestions.length,
  );
  assert.equal(allQuestions.length, 90);
  assert.deepEqual(
    [...new Set(allQuestions.map((question) => question.difficulty))].sort(),
    ["easy", "hard", "normal"],
  );

  const answerIds = allQuestions.flatMap((question) =>
    question.answers.map((answer) => answer.id),
  );
  assert.equal(new Set(answerIds).size, answerIds.length);

  for (const category of categories) {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      const questions = await repository.getQuestions({
        categoryId: category.id,
        difficulty,
      });
      assert.equal(questions.length, 10);
      for (const question of questions) {
        assert.equal(question.answers.length, 4);
        assert.equal(
          question.answers.filter((answer) => answer.isCorrect).length,
          1,
          `${question.id} must have exactly one correct answer`,
        );
      }
    }
  }
});
