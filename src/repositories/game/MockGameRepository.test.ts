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
    players.map(({ id, age }) => ({ id, age })),
    [
      { id: "amelia", age: 4 },
      { id: "joaquin", age: 6 },
      { id: "papa", age: 18 },
      { id: "mama", age: 18 },
    ],
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

test("conditionally adds generated games while keeping categories unique", async () => {
  const repository = new MockGameRepository();
  const existing = await repository.findById("animals");
  assert.ok(existing);
  await repository.create({ ...existing, id: "ai-animals-1", title: "Generated animals" });

  assert.equal((await repository.findById("ai-animals-1"))?.title, "Generated animals");
  assert.deepEqual((await repository.getCategories()).map((category) => category.id), ["animals", "space", "numbers"]);
  assert.equal((await repository.getQuestions({ categoryId: "animals", difficulty: "easy" })).length, 20);
  await assert.rejects(repository.create({ ...existing, id: "ai-animals-1" }), /already exists/i);
});

test("keeps generated-only categories and players out of legacy setup choices", async () => {
  const repository = new MockGameRepository();
  const existing = await repository.findById("animals");
  assert.ok(existing);
  await repository.create({
    ...existing,
    id: "ai-volcanoes-1",
    category: { id: "volcanoes", name: "Volcanoes", description: "Learn", icon: "🌋" },
    players: [{ id: "generated-player", name: "Generated", avatar: "G", age: 8 }],
    questions: existing.questions.map((question) => ({ ...question, categoryId: "volcanoes" })),
  });

  assert.deepEqual((await repository.getCategories()).map(({ id }) => id), ["animals", "space", "numbers"]);
  assert.equal((await repository.getPlayers()).some(({ id }) => id === "generated-player"), false);
  assert.equal((await repository.findAll()).some(({ id }) => id === "ai-volcanoes-1"), true);
  assert.equal((await repository.findById("ai-volcanoes-1"))?.category.id, "volcanoes");
});
