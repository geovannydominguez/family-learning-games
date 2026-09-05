import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSession,
  buildResult,
  createGameSession,
  restartGameSession,
  selectQuestions,
  submitAnswer,
} from "./gameSession.ts";
import type {
  Category,
  Player,
  Question,
} from "../../domain/game/types.ts";

const player: Player = { id: "amelia", name: "Amelia", avatar: "👧", age: 4 };
const category: Category = {
  id: "animals",
  name: "Animales",
  description: "Aprende sobre animales.",
  icon: "🐼",
};

function makeQuestions(
  count: number,
  categoryId = "animals",
  difficulty: Question["difficulty"] = "easy",
): Question[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${categoryId}-${difficulty}-${index}`,
    categoryId,
    difficulty,
    text: `Pregunta ${index + 1}`,
    emoji: "❓",
    answers: [
      { id: `correct-${index}`, text: "Correcta", isCorrect: true },
      { id: `wrong-a-${index}`, text: "Incorrecta A", isCorrect: false },
      { id: `wrong-b-${index}`, text: "Incorrecta B", isCorrect: false },
      { id: `wrong-c-${index}`, text: "Incorrecta C", isCorrect: false },
    ],
  }));
}

const deterministicRandom = () => 0;

test("filters questions by category and difficulty", () => {
  const questions = [
    ...makeQuestions(10, "animals", "easy"),
    ...makeQuestions(10, "space", "easy"),
    ...makeQuestions(10, "animals", "hard"),
  ];

  const selected = selectQuestions(
    questions,
    { categoryId: "animals", difficulty: "easy", count: 10 },
    deterministicRandom,
  );

  assert.equal(selected.length, 10);
  assert.ok(
    selected.every(
      (question) =>
        question.categoryId === "animals" && question.difficulty === "easy",
    ),
  );
});

test("selects 10 unique questions without mutating the source pool", () => {
  const questions = makeQuestions(12);
  const originalIds = questions.map((question) => question.id);

  const selected = selectQuestions(
    questions,
    { categoryId: "animals", difficulty: "easy", count: 10 },
    () => 0.5,
  );

  assert.equal(selected.length, 10);
  assert.equal(new Set(selected.map((question) => question.id)).size, 10);
  assert.deepEqual(
    questions.map((question) => question.id),
    originalIds,
  );
});

test("rejects an insufficient question pool", () => {
  assert.throws(
    () =>
      selectQuestions(
        makeQuestions(9),
        { categoryId: "animals", difficulty: "easy", count: 10 },
        deterministicRandom,
      ),
    /10 preguntas disponibles/,
  );
});

test("creates a clean initial 10-question session", () => {
  const session = createGameSession({
    gameId: "ai-animals-1",
    player,
    category,
    difficulty: "normal",
    questions: makeQuestions(10, "animals", "normal"),
    random: deterministicRandom,
  });

  assert.equal(session.gameId, "ai-animals-1");
  assert.equal(session.questions.length, 10);
  assert.equal(session.currentQuestionIndex, 0);
  assert.equal(session.score, 0);
  assert.deepEqual(session.answers, []);
  assert.equal(session.status, "playing");
  assert.equal(session.selectedAnswerId, null);
});

test("scores an answer once and ignores repeated submissions", () => {
  const initial = createGameSession({
    player,
    category,
    difficulty: "easy",
    questions: makeQuestions(10),
    random: deterministicRandom,
  });
  const question = initial.questions[0];
  const correctAnswer = question.answers.find((answer) => answer.isCorrect)!;
  const first = submitAnswer(initial, correctAnswer.id);
  const repeated = submitAnswer(first, correctAnswer.id);

  assert.equal(first.score, 1);
  assert.equal(first.answers.length, 1);
  assert.deepEqual(repeated, first);
});

test("does not advance before the current question is answered", () => {
  const session = createGameSession({
    player,
    category,
    difficulty: "easy",
    questions: makeQuestions(10),
    random: deterministicRandom,
  });

  assert.deepEqual(advanceSession(session), session);
});

test("completes only after all 10 questions are answered", () => {
  let session = createGameSession({
    player,
    category,
    difficulty: "easy",
    questions: makeQuestions(10),
    random: deterministicRandom,
  });

  for (let index = 0; index < 10; index += 1) {
    const question = session.questions[session.currentQuestionIndex];
    session = submitAnswer(session, question.answers[0].id);
    session = advanceSession(session);
  }

  assert.equal(session.status, "completed");
  assert.equal(session.answers.length, 10);
  assert.equal(session.score, 10);
});

test("builds a personalized result", () => {
  let session = createGameSession({
    player,
    category,
    difficulty: "easy",
    questions: makeQuestions(10),
    random: deterministicRandom,
  });

  for (let index = 0; index < 10; index += 1) {
    const question = session.questions[session.currentQuestionIndex];
    session = submitAnswer(session, question.answers[index < 8 ? 0 : 1].id);
    session = advanceSession(session);
  }

  assert.deepEqual(buildResult(session), {
    player,
    category,
    difficulty: "easy",
    score: 8,
    total: 10,
  });
});

test("restart keeps selections and clears game progress", () => {
  const questions = makeQuestions(11);
  let session = createGameSession({
    player,
    category,
    difficulty: "easy",
    questions,
    random: deterministicRandom,
  });
  session = submitAnswer(session, session.questions[0].answers[0].id);

  const restarted = restartGameSession(session, questions, () => 0.75);

  assert.equal(restarted.gameId, session.gameId);
  assert.equal(restarted.player.id, player.id);
  assert.equal(restarted.category.id, category.id);
  assert.equal(restarted.difficulty, "easy");
  assert.equal(restarted.score, 0);
  assert.equal(restarted.answers.length, 0);
  assert.equal(restarted.currentQuestionIndex, 0);
  assert.equal(restarted.selectedAnswerId, null);
  assert.equal(restarted.questions.length, 10);
  assert.notDeepEqual(
    restarted.questions.map((question) => question.id),
    session.questions.map((question) => question.id),
  );
});
