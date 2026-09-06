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
import { GenerateGameService, type GenerationFailureDiagnostic } from "./generateGameService.ts";

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
  diagnostics: GenerationFailureDiagnostic[] = [],
): GenerateGameService {
  return new GenerateGameService(generator, repository, {
    enabled,
    createId: () => "123e4567-e89b-12d3-a456-426614174000",
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
  // `category.id` and `question.categoryId` are Application-owned (see the
  // "Application owns category.id" tests); they are overwritten before the
  // validator runs, so they are no longer reachable failure modes here.
  const invalidDrafts: Array<(draft: GeneratedGameDraft) => void> = [
    (draft) => { draft.title = " "; },
    (draft) => { draft.title = "x".repeat(101); },
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
  draft.category.name = "n".repeat(100);
  draft.category.description = "d".repeat(300);
  draft.category.icon = "i".repeat(16);
  for (const [index, question] of draft.questions.entries()) {
    question.id = `${index}`.padEnd(80, "q");
    question.emoji = "e".repeat(16);
    question.image = "u".repeat(2048);
    for (const [answerIndex, answer] of question.answers.entries()) {
      answer.id = `${answerIndex}`.padEnd(80, "a");
    }
  }

  // An 80-char topic slugifies to an 80-char Application-owned category.id.
  const game = await createService(generatorFrom(() => draft)).generate({
    topic: "c".repeat(80),
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.equal(game.category.id, "c".repeat(80));
  assert.equal(game.questions[0].categoryId.length, 80);
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

test("records one diagnostic per failed attempt with the attempt number and correlation id", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    draft.questions.pop();
    return draft;
  });

  await assert.rejects(
    createService(generator, new StubGameRepository(), true, diagnostics).generate({
      topic: "dinosaurs",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
      correlationId: "req-abc-123",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.deepEqual(diagnostics, [
    { event: "ai_generation_failure", level: "warn", correlationId: "req-abc-123", attempt: 1, failureType: "validation_failed", validationRule: "question_count", validationField: "questions" },
    { event: "ai_generation_failure", level: "warn", correlationId: "req-abc-123", attempt: 2, failureType: "validation_failed", validationRule: "question_count", validationField: "questions" },
  ]);
});

test("classifies every structural validation rule and offending field for internal diagnostics", async () => {
  const cases: Array<{
    mutate: (draft: GeneratedGameDraft) => void;
    validationRule: string;
    validationField: string;
  }> = [
    { mutate: (draft) => { draft.questions.pop(); }, validationRule: "question_count", validationField: "questions" },
    { mutate: (draft) => { draft.questions[3].answers.pop(); }, validationRule: "answer_count", validationField: "questions[3].answers" },
    { mutate: (draft) => { draft.questions[3].answers.forEach((answer) => { answer.isCorrect = false; }); }, validationRule: "correct_answer_count", validationField: "questions[3].answers" },
    { mutate: (draft) => { draft.questions[4].id = draft.questions[0].id; }, validationRule: "duplicate_question_id", validationField: "questions[4].id" },
    { mutate: (draft) => { draft.questions[3].answers[2].id = draft.questions[3].answers[0].id; }, validationRule: "duplicate_answer_id", validationField: "questions[3].answers[2].id" },
    { mutate: (draft) => { draft.questions[4].text = draft.questions[0].text; }, validationRule: "duplicate_text", validationField: "questions[4].text" },
    { mutate: (draft) => { draft.questions[3].difficulty = "hard"; }, validationRule: "difficulty_mismatch", validationField: "questions[3].difficulty" },
    { mutate: (draft) => { draft.category.icon = "x".repeat(17); }, validationRule: "field_length", validationField: "category.icon" },
    { mutate: (draft) => { draft.title = " "; }, validationRule: "missing_required_field", validationField: "title" },
    { mutate: (draft) => { delete (draft.category as { name?: string }).name; }, validationRule: "missing_required_field", validationField: "category.name" },
    { mutate: (draft) => { delete (draft as { questions?: unknown }).questions; }, validationRule: "missing_required_field", validationField: "questions" },
    { mutate: (draft) => { delete (draft.questions[3] as { id?: string }).id; }, validationRule: "missing_required_field", validationField: "questions[3].id" },
    { mutate: (draft) => { delete (draft.questions[3] as { answers?: unknown }).answers; }, validationRule: "missing_required_field", validationField: "questions[3].answers" },
    { mutate: (draft) => { delete (draft.questions[4].answers[2] as { text?: string }).text; }, validationRule: "missing_required_field", validationField: "questions[4].answers[2].text" },
    { mutate: (draft) => { delete (draft.questions[4].answers[2] as { isCorrect?: boolean }).isCorrect; }, validationRule: "missing_required_field", validationField: "questions[4].answers[2].isCorrect" },
  ];

  for (const { mutate, validationRule, validationField } of cases) {
    const diagnostics: GenerationFailureDiagnostic[] = [];
    const generator = generatorFrom(() => {
      const draft = makeDraft();
      mutate(draft);
      return draft;
    });

    await assert.rejects(
      createService(generator, new StubGameRepository(), true, diagnostics).generate({
        topic: "dinosaurs",
        difficulty: "easy",
        questionCount: 10,
        playerId: "amelia",
      }),
      (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
    );

    assert.equal(diagnostics.length, 2, `expected two diagnostics for ${validationField}`);
    assert.equal(diagnostics[0].failureType, "validation_failed");
    assert.equal(diagnostics[0].validationRule, validationRule, `rule for ${validationField}`);
    assert.equal(diagnostics[0].validationField, validationField);
    assert.equal(diagnostics[1].attempt, 2);
    assert.equal(diagnostics[1].validationField, validationField);
  }
});

test("validationField carries only structural path segments, never a field value", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    // A model that emits a wildly unsafe id value must never leak that value:
    // the field path is "questions[2].id", the value is dropped entirely.
    delete (draft.questions[2] as { id?: string }).id;
    return draft;
  });

  await assert.rejects(
    createService(generator, new StubGameRepository(), true, diagnostics).generate({
      topic: "  <script>alert(1)</script>  ",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
      correlationId: "req-field-1",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.deepEqual(diagnostics[0], {
    event: "ai_generation_failure",
    level: "warn",
    correlationId: "req-field-1",
    attempt: 1,
    failureType: "validation_failed",
    validationRule: "missing_required_field",
    validationField: "questions[2].id",
  });
  const serialized = JSON.stringify(diagnostics);
  assert.equal(/[<>()]/.test(serialized), false);
  assert.equal(serialized.includes("script"), false);
  assert.equal(serialized.includes("Question"), false);
  assert.equal(serialized.includes("Answer"), false);
});

test("classifies technical provider faults as provider_error without a rule or leaked detail", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => { throw new Error("provider secret endpoint and prompt"); });

  await assert.rejects(
    createService(generator, new StubGameRepository(), true, diagnostics).generate({
      topic: "dinosaurs",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
      correlationId: "req-provider-1",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_FAILED",
  );

  assert.deepEqual(diagnostics, [
    { event: "ai_generation_failure", level: "warn", correlationId: "req-provider-1", attempt: 1, failureType: "provider_error" },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
});

test("surfaces safe guardrail stop reasons and never records prompts, topics, or answers", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => {
    throw new InvalidGeneratedGameCandidateError({ failureType: "guardrail_intervened", stopReason: "guardrail_intervened" });
  });

  await assert.rejects(
    createService(generator, new StubGameRepository(), true, diagnostics).generate({
      topic: "sensitive-secret-topic",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.failureType, "guardrail_intervened");
    assert.equal(diagnostic.stopReason, "guardrail_intervened");
    assert.equal("validationRule" in diagnostic, false);
    assert.equal("validationField" in diagnostic, false);
  }
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("sensitive-secret-topic"), false);
  assert.equal(serialized.includes("Question 0"), false);
  assert.equal(serialized.includes("Answer 0"), false);
  assert.equal(serialized.includes("targetAge"), false);
});

test("drops unsafe correlation ids and unsafe stop reasons from diagnostics", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => {
    throw new InvalidGeneratedGameCandidateError({ failureType: "invalid_json", stopReason: "weird reason with spaces" });
  });

  await assert.rejects(
    createService(generator, new StubGameRepository(), true, diagnostics).generate({
      topic: "dinosaurs",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
      correlationId: "unsafe id\nwith control chars",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.equal("correlationId" in diagnostic, false);
    assert.equal("stopReason" in diagnostic, false);
    assert.equal(diagnostic.failureType, "invalid_json");
  }
});

test("emits no diagnostics when the first attempt succeeds", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => makeDraft());

  await createService(generator, new StubGameRepository(), true, diagnostics).generate({
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
    correlationId: "req-ok-1",
  });

  assert.deepEqual(diagnostics, []);
});

test("records the first failing attempt then stops when a retry succeeds", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom((_request, call) => {
    const draft = makeDraft();
    if (call === 1) draft.questions[0].answers.pop();
    return draft;
  });

  await createService(generator, new StubGameRepository(), true, diagnostics).generate({
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
    correlationId: "req-retry-1",
  });

  assert.deepEqual(diagnostics, [
    { event: "ai_generation_failure", level: "warn", correlationId: "req-retry-1", attempt: 1, failureType: "validation_failed", validationRule: "answer_count", validationField: "questions[0].answers" },
  ]);
});

test("Application owns category.id: a draft with no category.id still generates", async () => {
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    delete (draft.category as { id?: string }).id;
    return draft;
  });
  const repository = new StubGameRepository();

  const game = await createService(generator, repository).generate({
    topic: "Números",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.equal(game.category.id, "numeros");
  assert.ok(game.questions.every((question) => question.categoryId === "numeros"));
  assert.deepEqual(repository.created, [game]);
});

test("Application owns category.id: an empty category.id is replaced by the topic slug", async () => {
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    draft.category.id = "   ";
    return draft;
  });

  const game = await createService(generator).generate({
    topic: "Números",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.equal(game.category.id, "numeros");
});

test("normalizes inconsistent question.categoryId values to the owned slug", async () => {
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    draft.category.id = "whatever-the-model-said";
    draft.questions[3].categoryId = "space";
    draft.questions[7].categoryId = "";
    return draft;
  });

  const game = await createService(generator).generate({
    topic: "Números",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.equal(game.category.id, "numeros");
  assert.ok(game.questions.every((question) => question.categoryId === "numeros"));
});

test("derives a hyphenated slug from a topic with accents and punctuation", async () => {
  const game = await createService(generatorFrom(() => makeDraft())).generate({
    topic: "Números y Sumas!",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.equal(game.category.id, "numeros-y-sumas");
});

test("falls back to a deterministic, bounded slug when the topic yields no usable characters", async () => {
  const first = await createService(generatorFrom(() => makeDraft())).generate({
    topic: "¿?—",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });

  assert.match(first.category.id, /^tema-[a-z0-9]+$/);
  assert.ok(first.category.id.length > 0 && first.category.id.length <= 80);

  const second = await createService(generatorFrom(() => makeDraft())).generate({
    topic: "¿?—",
    difficulty: "easy",
    questionCount: 10,
    playerId: "amelia",
  });
  assert.equal(second.category.id, first.category.id);
});

test("keeps game.id unique across generations while category.id stays stable", async () => {
  let counter = 0;
  const service = new GenerateGameService(
    generatorFrom(() => makeDraft()),
    new StubGameRepository(),
    { enabled: true, createId: () => `uuid-${(counter += 1)}` },
  );

  const first = await service.generate({ topic: "Números", difficulty: "easy", questionCount: 10, playerId: "amelia" });
  const second = await service.generate({ topic: "Números", difficulty: "easy", questionCount: 10, playerId: "amelia" });

  assert.equal(first.category.id, "numeros");
  assert.equal(second.category.id, "numeros");
  assert.notEqual(first.id, second.id);
  assert.ok(first.id.startsWith("ai-"));
  assert.ok(second.id.startsWith("ai-"));
});

test("does not relax the validator: a missing category.name still fails after id is normalized", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    delete (draft.category as { id?: string }).id;
    delete (draft.category as { name?: string }).name;
    return draft;
  });

  await assert.rejects(
    createService(generator, new StubGameRepository(), true, diagnostics).generate({
      topic: "Números",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].validationRule, "missing_required_field");
  assert.equal(diagnostics[0].validationField, "category.name");
});
