import assert from "node:assert/strict";
import test from "node:test";

import type { Category, Difficulty, Game, Player, Question } from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError, PersistenceError } from "../errors.ts";
import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameDraft,
  type GenerateGameCommand,
  type GenerateGameRequest,
  type GameGenerator,
} from "./GameGenerator.ts";
import { GenerateGameService } from "./generateGameService.ts";

const players: Player[] = [{ id: "amelia", name: "Amelia", avatar: "A", age: 4 }];

function makeDraft(): GeneratedGameDraft {
  return {
    title: "  Dinosaur quiz  ",
    difficulty: "easy",
    category: {
      id: "  dinosaurs  ",
      name: "  Dinosaurs  ",
      description: "  Learn about dinosaurs  ",
      icon: "  🦕  ",
    },
    questions: Array.from({ length: 10 }, (_, questionIndex) => ({
      id: `  q-${questionIndex}  `,
      categoryId: "  dinosaurs  ",
      difficulty: "easy",
      text: `  Question ${questionIndex}  `,
      answers: Array.from({ length: 4 }, (_, answerIndex) => ({
        id: `  q-${questionIndex}-a-${answerIndex}  `,
        text: `  Answer ${answerIndex}  `,
        isCorrect: answerIndex === 0,
      })),
    })),
  };
}

class StubGameRepository implements GameRepository {
  readonly created: Game[] = [];
  createFailure: unknown;

  async create(game: Game): Promise<void> {
    if (this.createFailure) throw this.createFailure;
    this.created.push(game);
  }

  async findAll(): Promise<Game[]> { return []; }
  async findById(): Promise<Game | null> { return null; }
  async getPlayers(): Promise<Player[]> { return players; }
  async getCategories(): Promise<Category[]> { return []; }
  async getQuestions(): Promise<Question[]> { return []; }
}

function generatorFrom(
  implementation: (request: GenerateGameRequest, call: number) => GeneratedGameDraft | Promise<GeneratedGameDraft>,
): GameGenerator & { calls: GenerateGameRequest[] } {
  const calls: GenerateGameRequest[] = [];
  return {
    calls,
    async generate(request) {
      calls.push(request);
      return implementation(request, calls.length);
    },
  };
}

function createService(
  generator: GameGenerator,
  repository = new StubGameRepository(),
  enabled = true,
): GenerateGameService {
  return new GenerateGameService(generator, repository, {
    enabled,
    createId: () => "123e4567-e89b-12d3-a456-426614174000",
  });
}

test("generates a normalized game with Application-owned identity", async () => {
  const generator = generatorFrom(() => makeDraft());
  const repository = new StubGameRepository();
  const service = createService(generator, repository);

  const game = await service.generate({ topic: "  dinosaurs  ", difficulty: "easy", questionCount: 10, playerId: "amelia" });

  assert.deepEqual(generator.calls, [{ topic: "dinosaurs", difficulty: "easy", questionCount: 10, targetAge: 4 }]);
  assert.equal(game.id, "ai-123e4567-e89b-12d3-a456-426614174000");
  assert.equal(game.title, "Dinosaur quiz");
  assert.equal(game.category.id, "dinosaurs");
  assert.equal(game.category.name, "Dinosaurs");
  assert.equal(game.questions[0].id, "q-0");
  assert.equal(game.questions[0].text, "Question 0");
  assert.equal(game.questions[0].answers[0].text, "Answer 0");
  assert.deepEqual(game.players, players);
  assert.deepEqual(repository.created, [game]);
});

test("rejects disabled and invalid requests without invoking the generator", async () => {
  const cases: Array<{
    request: GenerateGameCommand;
    enabled: boolean;
    code: string;
  }> = [
    { request: { topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" }, enabled: false, code: "AI_GENERATION_DISABLED" },
    { request: { topic: "   ", difficulty: "easy", questionCount: 10, playerId: "amelia" }, enabled: true, code: "INVALID_GENERATION_REQUEST" },
    { request: { topic: "x".repeat(81), difficulty: "easy", questionCount: 10, playerId: "amelia" }, enabled: true, code: "INVALID_GENERATION_REQUEST" },
    { request: { topic: "dinosaurs", difficulty: "expert" as Difficulty, questionCount: 10, playerId: "amelia" }, enabled: true, code: "INVALID_GENERATION_REQUEST" },
    { request: { topic: "dinosaurs", difficulty: "easy", questionCount: 9, playerId: "amelia" }, enabled: true, code: "INVALID_GENERATION_REQUEST" },
    { request: { topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "" }, enabled: true, code: "INVALID_GENERATION_REQUEST" },
  ];

  for (const scenario of cases) {
    const generator = generatorFrom(() => makeDraft());
    await assert.rejects(
      createService(generator, new StubGameRepository(), scenario.enabled).generate(scenario.request),
      (error: unknown) => error instanceof ApplicationError && error.code === scenario.code,
    );
    assert.equal(generator.calls.length, 0);
  }
});

test("resolves only the selected player's valid age before calling the generator", async () => {
  const generator = generatorFrom(() => makeDraft());
  const repository = new StubGameRepository();
  repository.getPlayers = async () => [
    { id: "amelia", name: "Amelia", avatar: "A", age: 4 },
    { id: "other", name: "Other", avatar: "O", age: 9 },
  ];

  await createService(generator, repository).generate({
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
    playerId: "other",
  });

  assert.deepEqual(generator.calls, [{ topic: "dinosaurs", difficulty: "easy", questionCount: 10, targetAge: 9 }]);
  assert.deepEqual(repository.created[0].players, await repository.getPlayers());
  assert.equal(JSON.stringify(generator.calls).includes("Other"), false);
  assert.equal(JSON.stringify(generator.calls).includes("avatar"), false);
});

test("rejects unknown players and invalid stored ages without calling the generator", async () => {
  for (const playersForScenario of [
    [{ id: "amelia", name: "Amelia", avatar: "A", age: 4 }],
    [{ id: "amelia", name: "Amelia", avatar: "A", age: 0 }],
    [{ id: "amelia", name: "Amelia", avatar: "A", age: 4.5 }],
  ]) {
    const generator = generatorFrom(() => makeDraft());
    const repository = new StubGameRepository();
    repository.getPlayers = async () => playersForScenario;
    const playerId = playersForScenario[0].age === 4 ? "missing" : "amelia";

    await assert.rejects(
      createService(generator, repository).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_GENERATION_REQUEST",
    );
    assert.equal(generator.calls.length, 0);
    assert.equal(repository.created.length, 0);
  }
});

test("deeply rejects every invalid candidate shape after exactly one retry", async () => {
  const invalidDrafts: Array<(draft: GeneratedGameDraft) => void> = [
    (draft) => { draft.title = " "; },
    (draft) => { draft.title = "x".repeat(101); },
    (draft) => { draft.category.id = " "; },
    (draft) => { draft.category.id = "x".repeat(81); },
    (draft) => { draft.category.name = " "; },
    (draft) => { draft.category.name = "x".repeat(101); },
    (draft) => { draft.category.description = " "; },
    (draft) => { draft.category.description = "x".repeat(301); },
    (draft) => { draft.category.icon = " "; },
    (draft) => { draft.category.icon = "x".repeat(17); },
    (draft) => { draft.difficulty = "hard"; },
    (draft) => { draft.questions.pop(); },
    (draft) => { draft.questions[1].id = draft.questions[0].id; },
    (draft) => { draft.questions[0].id = "x".repeat(81); },
    (draft) => { draft.questions[1].text = draft.questions[0].text; },
    (draft) => { draft.questions[0].text = " "; },
    (draft) => { draft.questions[0].text = "x".repeat(241); },
    (draft) => { draft.questions[0].categoryId = "space"; },
    (draft) => { draft.questions[0].difficulty = "hard"; },
    (draft) => { draft.questions[0].answers.pop(); },
    (draft) => { draft.questions[0].answers[1].id = draft.questions[0].answers[0].id; },
    (draft) => { draft.questions[0].answers[1].text = draft.questions[0].answers[0].text; },
    (draft) => { draft.questions[0].answers[0].id = " "; },
    (draft) => { draft.questions[0].answers[0].id = "x".repeat(81); },
    (draft) => { draft.questions[0].answers[0].text = " "; },
    (draft) => { draft.questions[0].answers[0].text = "x".repeat(121); },
    (draft) => { draft.questions[0].answers.forEach((answer) => { answer.isCorrect = false; }); },
    (draft) => { draft.questions[0].answers[1].isCorrect = true; },
    (draft) => { draft.questions[0].emoji = " "; },
    (draft) => { draft.questions[0].emoji = "x".repeat(17); },
    (draft) => { draft.questions[0].image = " "; },
    (draft) => { draft.questions[0].image = "x".repeat(2049); },
  ];

  for (const invalidate of invalidDrafts) {
    const generator = generatorFrom(() => {
      const draft = makeDraft();
      invalidate(draft);
      return draft;
    });
    const repository = new StubGameRepository();

    await assert.rejects(
      createService(generator, repository).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
    );
    assert.equal(generator.calls.length, 2);
    assert.equal(repository.created.length, 0);
  }
});

test("accepts generated metadata at the documented maximum lengths", async () => {
  const draft = makeDraft();
  draft.category.id = "c".repeat(80);
  draft.category.name = "n".repeat(100);
  draft.category.description = "d".repeat(300);
  draft.category.icon = "i".repeat(16);
  for (const [index, question] of draft.questions.entries()) {
    question.id = `${index}`.padEnd(80, "q");
    question.categoryId = draft.category.id;
    question.emoji = "e".repeat(16);
    question.image = "u".repeat(2048);
    for (const [answerIndex, answer] of question.answers.entries()) {
      answer.id = `${answerIndex}`.padEnd(80, "a");
    }
  }

  const game = await createService(generatorFrom(() => draft)).generate({
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.equal(game.category.id.length, 80);
  assert.equal(game.questions[0].image?.length, 2048);
});

test("retries once after invalid content and persists the next valid draft", async () => {
  const generator = generatorFrom((_request, call) => {
    const draft = makeDraft();
    if (call === 1) draft.questions = [];
    return draft;
  });
  const repository = new StubGameRepository();

  await createService(generator, repository).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" });

  assert.equal(generator.calls.length, 2);
  assert.equal(repository.created.length, 1);
});

test("allows answer IDs to repeat across questions when each question remains internally unique", async () => {
  const draft = makeDraft();
  for (const question of draft.questions) {
    question.answers.forEach((answer, index) => { answer.id = `answer-${index}`; });
  }
  const generator = generatorFrom(() => draft);

  await createService(generator).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" });

  assert.equal(generator.calls.length, 1);
});

test("retries only the provider-neutral invalid-candidate signal", async () => {
  const recoverable = generatorFrom((_request, call) => {
    if (call === 1) throw new InvalidGeneratedGameCandidateError();
    return makeDraft();
  });
  await createService(recoverable).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" });
  assert.equal(recoverable.calls.length, 2);

  const alwaysInvalid = generatorFrom(() => { throw new InvalidGeneratedGameCandidateError(); });
  await assert.rejects(
    createService(alwaysInvalid).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(alwaysInvalid.calls.length, 2);
});

test("maps technical generator failures without retrying or persisting", async () => {
  const generator = generatorFrom(() => { throw new Error("provider secret"); });
  const repository = new StubGameRepository();

  await assert.rejects(
    createService(generator, repository).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "AI_GENERATION_FAILED"
      && !error.message.includes("secret"),
  );
  assert.equal(generator.calls.length, 1);
  assert.equal(repository.created.length, 0);
});

test("does not retry conditional collisions or translate safe persistence failures", async () => {
  for (const failure of [
    new ApplicationError("GAME_ID_CONFLICT", "A game with this ID already exists."),
    new PersistenceError("create-game", new Error("transport"), "ai-safe"),
  ]) {
    const generator = generatorFrom(() => makeDraft());
    const repository = new StubGameRepository();
    repository.createFailure = failure;

    await assert.rejects(
      createService(generator, repository).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
      (error: unknown) => error === failure,
    );
    assert.equal(generator.calls.length, 1);
  }
});
