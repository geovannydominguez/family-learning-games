import assert from "node:assert/strict";
import test from "node:test";

import type { Category, Difficulty, Game, Player, Question } from "../../domain/game/types.ts";
import type { Player as FamilyPlayer } from "../../domain/player/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError, PersistenceError } from "../errors.ts";
import type { PlayerRepository } from "../player/PlayerRepository.ts";
import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameDraft,
  type GenerateGameCommand,
  type GenerateGameRequest,
  type GameGenerator,
} from "./GameGenerator.ts";
import {
  GameValidatorError,
  type GameValidationResult,
  type GameValidator,
  type ValidateGeneratedGameRequest,
} from "./GameValidator.ts";
import {
  GenerateGameService,
  type GenerationFailureDiagnostic,
  type GenerationPipelineEvent,
} from "./generateGameService.ts";

const players: Player[] = [{ id: "amelia", name: "Amelia", avatar: "A", age: 4 }];

const defaultFamilyPlayer: FamilyPlayer = {
  playerId: "amelia",
  name: "Amelia",
  age: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Minimal `PlayerRepository` double: the ADR-013 boundary this service resolves `targetAge` through. */
class StubPlayerRepository implements PlayerRepository {
  private players: FamilyPlayer[];

  constructor(players: FamilyPlayer[] = [defaultFamilyPlayer]) {
    this.players = players;
  }

  async list(): Promise<FamilyPlayer[]> { return this.players; }
  async getById(playerId: string): Promise<FamilyPlayer | null> {
    return this.players.find((player) => player.playerId === playerId) ?? null;
  }
  async create(player: FamilyPlayer): Promise<FamilyPlayer> { this.players.push(player); return player; }
  async update(player: FamilyPlayer): Promise<FamilyPlayer> {
    this.players = this.players.map((candidate) => (candidate.playerId === player.playerId ? player : candidate));
    return player;
  }
  async delete(playerId: string): Promise<void> {
    this.players = this.players.filter((candidate) => candidate.playerId !== playerId);
  }
}

/**
 * A structurally valid draft of exactly `count` questions. Generator mocks pass
 * `request.questionCount` so a repair round returns the batch size it was asked
 * for — the service now rejects any other length as `unexpected_question_count`.
 */
function makeDraft(count = 10): GeneratedGameDraft {
  return {
    title: "  Dinosaur quiz  ",
    difficulty: "easy",
    category: {
      id: "  dinosaurs  ",
      name: "  Dinosaurs  ",
      description: "  Learn about dinosaurs  ",
      icon: "  🦕  ",
    },
    questions: Array.from({ length: count }, (_, questionIndex) => ({
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

function generatorAnswerIndex(question: { answers: Array<{ isCorrect: boolean }> }): number {
  return question.answers.findIndex((answer) => answer.isCorrect);
}

/** Independent review that lands on the same option the generator marked. */
function agreeingReview(request: ValidateGeneratedGameRequest): GameValidationResult {
  return {
    issues: [],
    questions: request.draft.questions.map((question, index) => ({
      questionIndex: index,
      answerIndex: generatorAnswerIndex(question),
      confident: true,
      ambiguous: false,
      issues: [],
    })),
  };
}

/** Independent review that lands on a different (still valid) option for every question. */
function disagreeingReview(request: ValidateGeneratedGameRequest): GameValidationResult {
  return {
    issues: [],
    questions: request.draft.questions.map((question, index) => ({
      questionIndex: index,
      answerIndex: (generatorAnswerIndex(question) + 1) % question.answers.length,
      confident: true,
      ambiguous: false,
      issues: [],
    })),
  };
}

function validatorFrom(
  implementation: (
    request: ValidateGeneratedGameRequest,
    call: number,
  ) => GameValidationResult | Promise<GameValidationResult> = agreeingReview,
): GameValidator & { calls: ValidateGeneratedGameRequest[] } {
  const calls: ValidateGeneratedGameRequest[] = [];
  return {
    calls,
    async validate(request) {
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
  validator: GameValidator = validatorFrom(),
  playerRepository: PlayerRepository = new StubPlayerRepository(),
): GenerateGameService {
  return new GenerateGameService(generator, validator, repository, playerRepository, {
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
  // question / answer ids are reassigned by Application on final assembly
  assert.equal(game.questions[0].id, "q1");
  assert.equal(game.questions[0].answers[0].id, "q1a1");
  assert.equal(game.questions.length, 10);
  assert.equal(game.questions[0].text, "Question 0");
  assert.equal(game.questions[0].answers[0].text, "Answer 0");
  // The legacy static roster is no longer sourced for AI-generated games (v0.6).
  assert.deepEqual(game.players, []);
  assert.deepEqual(game.generationMetadata, { targetAge: 4, difficulty: "easy" });
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

test("resolves only the selected player's age (via PlayerRepository) before calling the generator", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom();
  const playerRepository = new StubPlayerRepository([
    defaultFamilyPlayer,
    { playerId: "other", name: "Other", age: 9, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);

  await createService(generator, new StubGameRepository(), true, [], validator, playerRepository).generate({
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
    playerId: "other",
  });

  assert.deepEqual(generator.calls, [{ topic: "dinosaurs", difficulty: "easy", questionCount: 10, targetAge: 9 }]);
});

/**
 * ADR-013 / v0.6 privacy boundary: the object crossing into `GameGenerator`
 * and `GameValidator` must carry only `topic`/`difficulty`/`questionCount`/
 * `targetAge` (+ repair-round bookkeeping) — never the player's identity.
 */
test("never forwards playerId, player name, or a session identifier to the generator or validator", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom();
  const playerRepository = new StubPlayerRepository([
    { playerId: "other", name: "Other", age: 9, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ]);

  await createService(generator, new StubGameRepository(), true, [], validator, playerRepository).generate({
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
    playerId: "other",
    correlationId: "session-abc-123",
  });

  const forbiddenKeys = ["playerId", "player", "name", "sessionId", "correlationId"];
  for (const call of generator.calls) {
    for (const key of forbiddenKeys) assert.equal(Object.hasOwn(call, key), false, `generator call must not carry "${key}"`);
  }
  for (const call of validator.calls) {
    for (const key of forbiddenKeys) assert.equal(Object.hasOwn(call, key), false, `validator call must not carry "${key}"`);
  }
  assert.equal(JSON.stringify(generator.calls).includes("Other"), false);
  assert.equal(JSON.stringify(validator.calls).includes("Other"), false);
  assert.equal(JSON.stringify(generator.calls).includes("other"), false);
  assert.equal(JSON.stringify(generator.calls).includes("session-abc-123"), false);
});

test("rejects unknown players and invalid stored ages without calling the generator", async () => {
  const scenarios: Array<{ players: FamilyPlayer[]; playerId: string }> = [
    { players: [defaultFamilyPlayer], playerId: "missing" },
    { players: [{ ...defaultFamilyPlayer, age: 0 }], playerId: "amelia" },
    { players: [{ ...defaultFamilyPlayer, age: 4.5 }], playerId: "amelia" },
  ];
  for (const scenario of scenarios) {
    const generator = generatorFrom(() => makeDraft());
    const repository = new StubGameRepository();
    const playerRepository = new StubPlayerRepository(scenario.players);

    await assert.rejects(
      createService(generator, repository, true, [], validatorFrom(), playerRepository)
        .generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: scenario.playerId }),
      (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_GENERATION_REQUEST",
    );
    assert.equal(generator.calls.length, 0);
    assert.equal(repository.created.length, 0);
  }
});

test("never persists when the same broken draft is returned every round", async () => {
  // Each mutation keeps at least one slot permanently invalid (a broken question
  // that never becomes valid, or missing/wrong game metadata). With repair
  // rounds the pool can never reach ten unique valid questions, so the request
  // exhausts and nothing is persisted. Question / answer ids are Application-
  // assigned, so a model reusing ids across rounds is not a failure mode.
  const invalidDrafts: Array<(draft: GeneratedGameDraft) => void> = [
    (draft) => { draft.title = " "; },
    (draft) => { draft.title = "x".repeat(101); },
    (draft) => { draft.category.name = " "; },
    (draft) => { draft.category.description = "x".repeat(301); },
    (draft) => { draft.category.icon = " "; },
    (draft) => { draft.category.icon = "x".repeat(17); },
    (draft) => { draft.difficulty = "hard"; },
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
  assert.equal(alwaysInvalid.calls.length, 5); // one per content-repair round; a malformed draft gets no technical retry
});

test("maps a technical generator failure to a fail-closed error after one bounded technical retry", async () => {
  const generator = generatorFrom(() => { throw new Error("provider secret"); });
  const repository = new StubGameRepository();

  await assert.rejects(
    createService(generator, repository).generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "AI_GENERATION_FAILED"
      && !error.message.includes("secret"),
  );
  assert.equal(generator.calls.length, 2); // 1 initial + 1 same-round technical retry, then fail closed
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

test("records one diagnostic per structurally-failed slot, with the round number and correlation id", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const generator = generatorFrom((request) => {
    const draft = makeDraft(request.questionCount);
    // Question 0 of every batch is never structurally valid (no correct answer),
    // so each repair round for the last missing slot rejects it again and the
    // pool stays stuck at nine until the round budget is exhausted.
    draft.questions[0].answers.forEach((answer) => { answer.isCorrect = false; });
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

  const q0Failures = diagnostics.filter((diagnostic) => diagnostic.validationRule === "correct_answer_count");
  assert.equal(q0Failures.length, 5); // one per content-repair round
  assert.deepEqual(q0Failures.map((diagnostic) => diagnostic.attempt), [1, 2, 3, 4, 5]);
  for (const diagnostic of q0Failures) {
    assert.equal(diagnostic.event, "ai_generation_failure");
    assert.equal(diagnostic.correlationId, "req-abc-123");
    assert.equal(diagnostic.failureType, "validation_failed");
    assert.equal(diagnostic.validationField, "questions[0].answers");
  }
});

test("classifies every per-question structural rule and offending field for internal diagnostics", async () => {
  // A single broken question is repaired, not fatal; these mutate a question so
  // it never becomes valid, so the pool stalls at nine and the request exhausts.
  const cases: Array<{
    mutate: (draft: GeneratedGameDraft) => void;
    validationRule: string;
    validationField: string;
  }> = [
    { mutate: (draft) => { draft.questions[3].answers.pop(); }, validationRule: "answer_count", validationField: "questions[3].answers" },
    { mutate: (draft) => { draft.questions[3].answers.forEach((answer) => { answer.isCorrect = false; }); }, validationRule: "correct_answer_count", validationField: "questions[3].answers" },
    { mutate: (draft) => { draft.questions[3].answers[2].id = draft.questions[3].answers[0].id; }, validationRule: "duplicate_answer_id", validationField: "questions[3].answers[2].id" },
    { mutate: (draft) => { draft.questions[3].difficulty = "hard"; }, validationRule: "difficulty_mismatch", validationField: "questions[3].difficulty" },
    { mutate: (draft) => { delete (draft.questions[3] as { id?: string }).id; }, validationRule: "missing_required_field", validationField: "questions[3].id" },
    { mutate: (draft) => { delete (draft.questions[3] as { answers?: unknown }).answers; }, validationRule: "missing_required_field", validationField: "questions[3].answers" },
    { mutate: (draft) => { draft.questions[3].text = "x".repeat(241); }, validationRule: "field_length", validationField: "questions[3].text" },
    { mutate: (draft) => { delete (draft.questions[3].answers[2] as { text?: string }).text; }, validationRule: "missing_required_field", validationField: "questions[3].answers[2].text" },
    { mutate: (draft) => { delete (draft.questions[3].answers[2] as { isCorrect?: boolean }).isCorrect; }, validationRule: "missing_required_field", validationField: "questions[3].answers[2].isCorrect" },
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

    assert.ok(diagnostics.length >= 1, `expected a diagnostic for ${validationField}`);
    assert.equal(diagnostics[0].failureType, "validation_failed");
    assert.equal(diagnostics[0].validationRule, validationRule, `rule for ${validationField}`);
    assert.equal(diagnostics[0].validationField, validationField);
    assert.equal(diagnostics[0].attempt, 1);
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
    { event: "ai_generation_failure", level: "warn", correlationId: "req-provider-1", attempt: 1, technicalRetry: 1, failureType: "provider_error" },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
});

test("a guardrail block finalizes as AI_GENERATION_BLOCKED without a technical retry or extra rounds", async () => {
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
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_BLOCKED",
  );

  // A Guardrail block is deterministic and request-driven: exactly ONE generator
  // call, no same-round technical retry, no cascade of identical calls.
  assert.equal(generator.calls.length, 1);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic.failureType, "guardrail_intervened");
  assert.equal(diagnostic.stopReason, "guardrail_intervened");
  assert.equal("technicalRetry" in diagnostic, false);
  assert.equal("validationRule" in diagnostic, false);
  assert.equal("validationField" in diagnostic, false);
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

  assert.equal(diagnostics.length, 10); // 5 rounds × (1 initial + 1 technical retry) for a malformed response
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
  const generator = generatorFrom((request, call) => {
    const draft = makeDraft(request.questionCount);
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
    validatorFrom(),
    new StubGameRepository(),
    new StubPlayerRepository(),
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

test("does not relax metadata validation: a game with no valid category name is never persisted", async () => {
  const repository = new StubGameRepository();
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    delete (draft.category as { id?: string }).id;
    delete (draft.category as { name?: string }).name;
    return draft;
  });

  // The questions are all fine, but game metadata never becomes valid, so
  // assembly fails closed rather than persisting a game with a blank category.
  await assert.rejects(
    createService(generator, repository).generate({
      topic: "Números",
      difficulty: "easy",
      questionCount: 10,
      playerId: "amelia",
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
});

// --- Two-model pipeline: Nova Micro drafts, Nova Pro reviews before persistence ---

function serviceWith(
  generator: GameGenerator,
  validator: GameValidator,
  repository = new StubGameRepository(),
  events: GenerationPipelineEvent[] = [],
): { service: GenerateGameService; repository: StubGameRepository; events: GenerationPipelineEvent[] } {
  const service = new GenerateGameService(generator, validator, repository, new StubPlayerRepository(), {
    enabled: true,
    createId: () => "123e4567-e89b-12d3-a456-426614174000",
    logEvent: (event) => events.push(event),
    models: { generator: "amazon.nova-lite-v1:0", validator: "amazon.nova-pro-v1:0" },
  });
  return { service, repository, events };
}

const generateCommand: GenerateGameCommand = { topic: "Pokémon", difficulty: "easy", questionCount: 10, playerId: "amelia" };

/** A `count`-question draft whose first question is the real production bug. */
function bulbasaurDraft(correctAnswerIndex: number, count = 10): GeneratedGameDraft {
  const draft = makeDraft(count);
  draft.questions[0] = {
    id: "q-bulbasaur",
    categoryId: draft.questions[0].categoryId,
    difficulty: "easy",
    text: "¿Cuál es el Pokémon tipo planta que evoluciona de Bulbasaur?",
    answers: ["Ivysaur", "Venusaur", "Pikachu", "Charizard"].map((text, index) => ({
      id: `q-bulbasaur-a-${index}`,
      text,
      isCorrect: index === correctAnswerIndex,
    })),
  };
  return draft;
}

/** Agreeing review, but the first question forced to a specific independent answer. */
function reviewFirstQuestionAs(
  first: { answerIndex: number | null; confident?: boolean; ambiguous?: boolean; issues?: GameValidationResult["issues"] },
): (request: ValidateGeneratedGameRequest) => GameValidationResult {
  return (request) => {
    const review = agreeingReview(request);
    review.questions[0] = {
      questionIndex: 0,
      answerIndex: first.answerIndex,
      confident: first.confident ?? true,
      ambiguous: first.ambiguous ?? false,
      issues: first.issues ?? [],
    };
    return review;
  };
}

test("valid pipeline: ten generated, one round, one save", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(agreeingReview);
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 1);
  assert.equal(generator.calls[0].questionCount, 10);
  assert.equal(validator.calls.length, 1);
  assert.deepEqual(repository.created, [game]);
  assert.equal(validator.calls[0].draft.questions.length, 10);
  assert.equal(validator.calls[0].targetAge, 4);
  assert.equal(game.questions.length, 10);
  assert.deepEqual(
    events.map((event) => event.event),
    ["AI_GAME_GENERATION_ATTEMPT", "AI_GAME_REPAIR_ROUND", "AI_GAME_VALIDATION_SUCCEEDED"],
  );
  const attempt = events[0];
  assert.equal(attempt.round, 1);
  assert.equal(attempt.requestedQuestionCount, 10);
  assert.equal(attempt.acceptedQuestionCount, 0);
  const repair = events[1];
  assert.equal(repair.acceptedCount, 10);
  assert.equal(repair.rejectedQuestionCount, 0);
  assert.equal(repair.generatedCount, 10);
  assert.equal(repair.issueCount, 0);
  assert.equal(repair.missingCount, 0);
  const succeeded = events[2];
  assert.equal(succeeded.questionCount, 10);
  assert.equal(succeeded.acceptedQuestionCount, 10);
  assert.equal(succeeded.validatorModel, "amazon.nova-pro-v1:0");
});

test("regression: reviewer independently picks Ivysaur, generator marked Venusaur → INVALID, not persisted", async () => {
  // Bulbasaur → Ivysaur → Venusaur. The direct evolution is Ivysaur (index 0).
  const generator = generatorFrom((request) => bulbasaurDraft(1, request.questionCount)); // generator wrongly marks Venusaur
  const validator = validatorFrom(reviewFirstQuestionAs({ answerIndex: 0, confident: true, ambiguous: false, issues: [] }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(repository.created.length, 0);
  assert.equal(generator.calls.length, 5); // one content-repair round per attempt, up to MAX_REPAIR_ROUNDS
  assert.equal(validator.calls.length, 5);
  const rejected = events.find((event) => event.event === "AI_GAME_VALIDATION_REJECTED");
  assert.ok(rejected);
  assert.equal(rejected.questionIndex, 0);
  assert.equal(rejected.generatorAnswerIndex, 1);
  assert.equal(rejected.validatorAnswerIndex, 0);
  assert.deepEqual(rejected.issueTypes, ["ANSWER_MISMATCH"]);
});

test("positive: reviewer independently picks the same option the generator marked → VALID, persisted", async () => {
  const generator = generatorFrom(() => bulbasaurDraft(0)); // generator correctly marks Ivysaur
  const validator = validatorFrom(reviewFirstQuestionAs({ answerIndex: 0, confident: true, ambiguous: false, issues: [] }));
  const { service, repository, events } = serviceWith(generator, validator);

  await service.generate(generateCommand);

  assert.equal(repository.created.length, 1);
  assert.equal(generator.calls.length, 1);
  assert.equal(validator.calls.length, 1);
  assert.equal(events.at(-1)?.event, "AI_GAME_VALIDATION_SUCCEEDED");
});

test("mismatch on any single question rejects the whole draft", async () => {
  const generator = generatorFrom((request) => makeDraft(request.questionCount));
  const validator = validatorFrom((request, call) => (call < 3
    ? reviewFirstQuestionAs({ answerIndex: 2 })(request) // wrong option for Q0
    : agreeingReview(request)));
  const { service, repository } = serviceWith(generator, validator);

  await service.generate(generateCommand); // succeeds on attempt 3

  assert.equal(generator.calls.length, 3);
  assert.equal(validator.calls.length, 3);
  assert.equal(repository.created.length, 1);
});

test("low confidence rejects the question even when the answer index would match", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({ answerIndex: 0, confident: false }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && event.confident === false
    && (event.issueTypes ?? []).includes("FACTUAL_UNCERTAINTY")));
});

test("ambiguous flag rejects the question", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({ answerIndex: 0, ambiguous: true }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && event.ambiguous === true
    && (event.issueTypes ?? []).includes("AMBIGUOUS_QUESTION")));
});

test("a null independent answer rejects the question", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({ answerIndex: null, confident: false }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED" && event.validatorAnswerIndex === null));
});

test("a reviewer-reported per-question issue rejects the question even with a matching answer", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({
    answerIndex: 0,
    issues: [{ questionIndex: 0, type: "OFF_TOPIC", reason: "not about the topic" }],
  }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("OFF_TOPIC")));
});

test("Case A — answers match, distractors judged easy: warning does not reject, draft persists", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({
    answerIndex: 0, // matches the generator's marked option
    issues: [{ questionIndex: 0, type: "TOO_EASY_DISTRACTOR", reason: "Bulbasaur/Squirtle are obviously not electric" }],
  }));
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.deepEqual(repository.created, [game]);
  const succeeded = events.find((event) => event.event === "AI_GAME_VALIDATION_SUCCEEDED");
  assert.ok(succeeded);
  assert.equal(succeeded.warningCount, 1);
  assert.deepEqual(succeeded.warningTypes, ["TOO_EASY_DISTRACTOR"]);
  assert.equal(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"), false);
});

test("Case E — WEAK_DISTRACTOR warning with a matching factual answer stays VALID", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({
    answerIndex: 0,
    confident: true,
    ambiguous: false,
    issues: [{ questionIndex: 0, type: "WEAK_DISTRACTOR", reason: "distractor is weak" }],
  }));
  const { service, repository } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.deepEqual(repository.created, [game]);
});

test("a hard code the model tries to downgrade to a warning still blocks", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({
    answerIndex: 0,
    issues: [{ questionIndex: 0, type: "INVALID_OPTIONS", severity: "warning", reason: "the model claims this is minor" }],
  }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("INVALID_OPTIONS")));
});

test("Case D — MULTIPLE_CORRECT_ANSWERS (hard) rejects the draft", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewFirstQuestionAs({
    answerIndex: 0,
    issues: [{ questionIndex: 0, type: "MULTIPLE_CORRECT_ANSWERS", reason: "two options are electric" }],
  }));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("MULTIPLE_CORRECT_ANSWERS")));
});

test("Case C — a question with an objectively duplicate option is rejected structurally and never reviewed", async () => {
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    draft.questions[0].answers[1].text = draft.questions[0].answers[0].text; // duplicate option text
    return draft;
  });
  const validator = validatorFrom(agreeingReview);
  const { service, repository, events } = serviceWith(generator, validator);

  // Q0 never becomes valid; the other nine keep being duplicates on repair, so the request exhausts.
  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );
  assert.equal(repository.created.length, 0);
  // the broken question never reaches the reviewer
  for (const call of validator.calls) {
    assert.equal(call.draft.questions.some((question) => question.text.includes("Question 0")), false);
  }
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("duplicate_text")));
});

test("first draft mismatched, second draft agreed: two cycles, one save, hints fed back", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom((request, call) => (call === 1 ? disagreeingReview(request) : agreeingReview(request)));
  const { service, repository, events } = serviceWith(generator, validator);

  await service.generate(generateCommand);

  assert.equal(generator.calls.length, 2);
  assert.equal(validator.calls.length, 2);
  assert.equal(repository.created.length, 1);
  assert.equal(generator.calls[0].previousIssues, undefined);
  assert.ok((generator.calls[1].previousIssues ?? []).length > 0);
  assert.equal(generator.calls[1].previousIssues?.[0].type, "ANSWER_MISMATCH");
  assert.deepEqual(
    events
      .map((event) => event.event)
      .filter((name) => name === "AI_GAME_GENERATION_ATTEMPT" || name === "AI_GAME_VALIDATION_SUCCEEDED"),
    ["AI_GAME_GENERATION_ATTEMPT", "AI_GAME_GENERATION_ATTEMPT", "AI_GAME_VALIDATION_SUCCEEDED"],
  );
});

test("every draft disagreed: no save after the attempt budget is exhausted", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(disagreeingReview);
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(generator.calls.length, 5);
  assert.equal(validator.calls.length, 5);
  assert.equal(repository.created.length, 0);
  assert.equal(events.at(-1)?.event, "AI_GAME_GENERATION_EXHAUSTED");
});

test("validator technical failure fails closed without saving or retrying", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(() => { throw new GameValidatorError(); });
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_FAILED",
  );

  assert.equal(generator.calls.length, 1);
  assert.equal(validator.calls.length, 1);
  assert.equal(repository.created.length, 0);
  assert.equal(events.some((event) => event.event === "AI_GAME_VALIDATION_ERROR"), true);
});

test("generator technical failure never reaches the validator or the repository", async () => {
  const generator = generatorFrom(() => { throw new Error("provider transport failure"); });
  const validator = validatorFrom(agreeingReview);
  const { service, repository } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_FAILED",
  );

  assert.equal(generator.calls.length, 2); // 1 initial + 1 bounded technical retry, then fail closed
  assert.equal(validator.calls.length, 0);
  assert.equal(repository.created.length, 0);
});

test("a round whose every candidate is structurally invalid never reaches the reviewer", async () => {
  const generator = generatorFrom(() => {
    const draft = makeDraft();
    for (const question of draft.questions) question.answers.pop(); // every question has 3 options
    return draft;
  });
  const validator = validatorFrom(agreeingReview);
  const { service, repository } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(generator.calls.length, 5);
  assert.equal(validator.calls.length, 0);
  assert.equal(repository.created.length, 0);
});

test("a configurable attempt budget bounds the Generate → Validate cycles", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(disagreeingReview);
  const repository = new StubGameRepository();
  const service = new GenerateGameService(generator, validator, repository, new StubPlayerRepository(), {
    enabled: true,
    createId: () => "id",
    maxAttempts: 2,
  });

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(generator.calls.length, 2);
  assert.equal(validator.calls.length, 2);
  assert.equal(repository.created.length, 0);
});

// --- Question-level repair rounds: keep valid questions, regenerate only failed slots ---

/** A draft whose questions carry the given texts; every question is structurally valid. */
function draftWithQuestionTexts(texts: string[]): GeneratedGameDraft {
  const draft = makeDraft();
  draft.questions = texts.map((text, questionIndex) => ({
    id: `gen-${questionIndex}-${text}`,
    categoryId: draft.category.id,
    difficulty: "easy",
    text,
    answers: Array.from({ length: 4 }, (_, answerIndex) => ({
      id: `gen-${questionIndex}-${text}-a${answerIndex}`,
      text: `${text} option ${answerIndex}`,
      isCorrect: answerIndex === 0,
    })),
  }));
  return draft;
}

/** Review that accepts every candidate whose text is NOT in `rejectTexts`. */
function reviewRejecting(rejectTexts: readonly string[]): (request: ValidateGeneratedGameRequest) => GameValidationResult {
  return (request) => ({
    issues: [],
    questions: request.draft.questions.map((question, index) => {
      const reject = rejectTexts.some((needle) => question.text.includes(needle));
      return {
        questionIndex: index,
        answerIndex: reject
          ? (generatorAnswerIndex(question) + 1) % question.answers.length // mismatch → ANSWER_MISMATCH
          : generatorAnswerIndex(question),
        confident: true,
        ambiguous: false,
        issues: [],
      };
    }),
  });
}

test("repair 1: ten generated and all valid → generator once, validator once, repository once", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(agreeingReview);
  const { service, repository } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 1);
  assert.equal(validator.calls.length, 1);
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
});

test("repair 2: nine valid + one ANSWER_MISMATCH → keep nine, ask for one replacement, save once", async () => {
  const generator = generatorFrom((_request, call) => (call === 1
    ? makeDraft() // "Question 0".."Question 9"
    : draftWithQuestionTexts(["Replacement question"])));
  const validator = validatorFrom(reviewRejecting(["Question 0"])); // reject only the first slot
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 2);
  assert.equal(generator.calls[0].questionCount, 10);
  assert.equal(generator.calls[1].questionCount, 1); // only the failed slot is regenerated
  // The exclusion list is every question SEEN in round 1 — the 9 accepted AND the
  // rejected "Question 0" — so Nova Lite is told not to reproduce that one either.
  assert.deepEqual([...(generator.calls[1].existingQuestions ?? [])].sort(), [
    "Question 0", "Question 1", "Question 2", "Question 3", "Question 4",
    "Question 5", "Question 6", "Question 7", "Question 8", "Question 9",
  ]);
  assert.equal(validator.calls.length, 2);
  assert.equal(validator.calls[1].draft.questions.length, 1);
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
  assert.equal(new Set(game.questions.map((question) => question.text)).size, 10);
  assert.ok(game.questions.some((question) => question.text === "Replacement question"));
  assert.equal(game.questions.some((question) => question.text === "Question 0"), false);
  const repairRounds = events.filter((event) => event.event === "AI_GAME_REPAIR_ROUND");
  assert.equal(repairRounds[0].acceptedCount, 9);
  assert.equal(repairRounds[0].rejectedQuestionCount, 1);
  assert.equal(repairRounds[0].generatedCount, 10);
  assert.equal(repairRounds[0].issueCount, 1);
  assert.equal(repairRounds[0].missingCount, 1);
  assert.equal(repairRounds[1].acceptedCount, 1);
  assert.equal(repairRounds[1].missingCount, 0);
});

test("repair 3: one structural failure → keep the other valid questions, regenerate only the failed slot", async () => {
  const generator = generatorFrom((_request, call) => {
    if (call === 1) {
      const draft = makeDraft();
      draft.questions[5].answers.pop(); // Q5 structurally invalid (3 options)
      return draft;
    }
    return draftWithQuestionTexts(["Structural replacement"]);
  });
  const validator = validatorFrom(agreeingReview);
  const { service, repository } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 2);
  assert.equal(generator.calls[1].questionCount, 1);
  assert.equal(validator.calls[0].draft.questions.length, 9); // the broken slot never reaches the reviewer
  assert.equal(validator.calls.length, 2);
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
});

test("repair 4: multiple repair rounds assemble exactly ten and persist once", async () => {
  const generator = generatorFrom((_request, call) => {
    if (call === 1) return makeDraft(); // Q0, Q1 will be rejected → 8 accepted
    if (call === 2) return draftWithQuestionTexts(["R2 good", "R2 bad"]);
    return draftWithQuestionTexts(["R3 good"]);
  });
  const validator = validatorFrom(reviewRejecting(["Question 0", "Question 1", "R2 bad"]));
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 3);
  assert.deepEqual(generator.calls.map((call) => call.questionCount), [10, 2, 1]);
  assert.equal(validator.calls.length, 3);
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
  assert.equal(new Set(game.questions.map((question) => question.text)).size, 10);
  const succeeded = events.find((event) => event.event === "AI_GAME_VALIDATION_SUCCEEDED");
  assert.equal(succeeded?.acceptedQuestionCount, 10);
});

test("repair 5: repair rounds exhausted → repository 0 and a 422-compatible application error", async () => {
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom(reviewRejecting(["Question 9"])); // one slot always fails
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(repository.created.length, 0);
  assert.equal(generator.calls.length, 5); // one content-repair round per generation, up to MAX_REPAIR_ROUNDS = 5
  assert.equal(events.at(-1)?.event, "AI_GAME_GENERATION_EXHAUSTED");
  assert.equal(events.at(-1)?.acceptedQuestionCount, 9);
  assert.equal(events.at(-1)?.missingCount, 1);
});

test("repair 6: a replacement that duplicates an accepted question is rejected and the pool is not corrupted", async () => {
  const generator = generatorFrom((_request, call) => {
    if (call === 1) return makeDraft(); // Q0 rejected → 9 accepted
    if (call === 2) return draftWithQuestionTexts(["Question 3"]); // duplicate of an accepted question
    return draftWithQuestionTexts(["Genuinely new question"]);
  });
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 3);
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
  assert.equal(new Set(game.questions.map((question) => question.text)).size, 10);
  assert.equal(game.questions.filter((question) => question.text === "Question 3").length, 1);
  assert.ok(game.questions.some((question) => question.text === "Genuinely new question"));
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("duplicate_text")));
});

test("v0.5.1: round 1 (8 accepted / 2 rejected) → round 2 asks for exactly 2 with every seen question excluded → 10 persisted", async () => {
  const generator = generatorFrom((request, call) => (call === 1
    ? makeDraft() // "Question 0".."Question 9"
    : draftWithQuestionTexts(["Nuevo hecho A", "Nuevo hecho B"].slice(0, request.questionCount))));
  const validator = validatorFrom(reviewRejecting(["Question 0", "Question 1"])); // ANSWER_MISMATCH on 2 slots
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 2);
  assert.equal(generator.calls[1].questionCount, 2); // exactly the missing count
  // the generator is given ALL ten round-1 texts as exclusion context — the 8
  // accepted AND the 2 rejected — not just the accepted pool.
  assert.deepEqual([...(generator.calls[1].existingQuestions ?? [])].sort(), [
    "Question 0", "Question 1", "Question 2", "Question 3", "Question 4",
    "Question 5", "Question 6", "Question 7", "Question 8", "Question 9",
  ]);
  assert.equal(validator.calls.length, 2);
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
  assert.equal(new Set(game.questions.map((question) => question.text)).size, 10);
  assert.ok(game.questions.some((question) => question.text === "Nuevo hecho A"));
  assert.ok(game.questions.some((question) => question.text === "Nuevo hecho B"));
  // a rejected question never enters the accepted pool / final game.
  assert.equal(game.questions.some((question) => question.text === "Question 0" || question.text === "Question 1"), false);
  const repair = events.filter((event) => event.event === "AI_GAME_REPAIR_ROUND");
  assert.equal(repair[0].seenQuestionCount, 10);
  assert.equal(repair[1].requestedQuestionCount, 2);
  const attempts = events.filter((event) => event.event === "AI_GAME_GENERATION_ATTEMPT");
  assert.equal(attempts[0].seenQuestionCount, 0);
  assert.equal(attempts[1].seenQuestionCount, 10);
});

test("the exclusion set grows monotonically: a question generated and rejected in round 2 is excluded from round 3", async () => {
  const generator = generatorFrom((_request, call) => {
    if (call === 1) return makeDraft(); // Q0 rejected → 9 accepted
    if (call === 2) return draftWithQuestionTexts(["Intento fallido"]); // rejected by Nova Pro
    return draftWithQuestionTexts(["Pregunta final"]); // round 3 → accepted
  });
  const validator = validatorFrom(reviewRejecting(["Question 0", "Intento fallido"]));
  const { service, repository } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(generator.calls.length, 3);
  const round3Exclusions = [...(generator.calls[2].existingQuestions ?? [])];
  assert.ok(round3Exclusions.includes("Question 0")); // round-1 rejected
  assert.ok(round3Exclusions.includes("Intento fallido")); // round-2 generated then rejected
  assert.equal(round3Exclusions.length, 11); // Q0..Q9 + "Intento fallido"
  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
  assert.equal(game.questions.some((question) => question.text === "Intento fallido"), false);
});

test("a generator that keeps repeating an accepted question exhausts controlled, without re-reviewing the duplicate", async () => {
  const generator = generatorFrom((_request, call) => (call === 1
    ? makeDraft() // Q0 rejected → 9 accepted
    : draftWithQuestionTexts(["Question 5"]))); // always a duplicate of an accepted question
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const { service, repository, events } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  assert.equal(repository.created.length, 0);
  assert.equal(generator.calls.length, 5); // maxAttempts still respected
  assert.equal(validator.calls.length, 1); // rounds 2..5 blocked deterministically → Nova Pro not re-run
  const dup = events.filter((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("duplicate_text"));
  assert.equal(dup.length, 4);
  assert.equal(events.at(-1)?.event, "AI_GAME_GENERATION_EXHAUSTED");
});

test("duplicate_text catches a trivial case / whitespace variant of an accepted question", async () => {
  const generator = generatorFrom((_request, call) => {
    if (call === 1) return makeDraft();
    if (call === 2) return draftWithQuestionTexts(["  question 5 "]); // same as accepted "Question 5" once normalized
    return draftWithQuestionTexts(["Distinct new question"]);
  });
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.deepEqual(repository.created, [game]);
  assert.equal(generator.calls.length, 3); // round 2's near-duplicate rejected, round 3 recovers
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("duplicate_text")));
  assert.equal(game.questions.some((question) => question.text.trim() === "question 5"), false);
});

function guardrailFailure(): InvalidGeneratedGameCandidateError {
  return new InvalidGeneratedGameCandidateError({
    failureType: "guardrail_intervened",
    stopReason: "guardrail_intervened",
    guardrail: {
      guardrailId: "gr-abc",
      guardrailVersion: "3",
      assessments: [{ policy: "contentPolicy", type: "PROMPT_ATTACK", action: "BLOCKED", confidence: "HIGH" }],
    },
  });
}

function serviceWithLogs(
  generator: GameGenerator,
  validator: GameValidator,
): {
  service: GenerateGameService;
  repository: StubGameRepository;
  events: GenerationPipelineEvent[];
  diagnostics: GenerationFailureDiagnostic[];
} {
  const events: GenerationPipelineEvent[] = [];
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const repository = new StubGameRepository();
  const service = new GenerateGameService(generator, validator, repository, new StubPlayerRepository(), {
    enabled: true,
    createId: () => "id",
    logEvent: (event) => events.push(event),
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    models: { generator: "amazon.nova-lite-v1:0", validator: "amazon.nova-pro-v1:0" },
  });
  return { service, repository, events, diagnostics };
}

test("A. guardrail block on the first round: finalize immediately, never touch Nova Pro or a repair round", async () => {
  const generator = generatorFrom(() => { throw guardrailFailure(); });
  const validator = validatorFrom();
  const { service, repository, events, diagnostics } = serviceWithLogs(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_BLOCKED",
  );

  assert.equal(repository.created.length, 0);
  // exactly one generator call — no same-round technical retry, no further rounds
  assert.equal(generator.calls.length, 1);
  // the generation was blocked before any candidate existed, so the semantic
  // validator (Nova Pro) is never invoked and no repair round is accounted for
  assert.equal(validator.calls.length, 0);
  assert.equal(events.some((event) => event.event === "AI_GAME_REPAIR_ROUND"), false);
  assert.equal(events.some((event) => event.event === "AI_GAME_GENERATION_EXHAUSTED"), false);
  const attempts = events.filter((event) => event.event === "AI_GAME_GENERATION_ATTEMPT");
  assert.deepEqual(attempts.map((event) => event.technicalRetry), [0]);
  const guardrail = events.filter((event) => event.event === "AI_GAME_GUARDRAIL_INTERVENED");
  assert.equal(guardrail.length, 1);
  assert.equal(guardrail[0].round, 1);
  assert.equal(guardrail[0].technicalRetry, 0);
  assert.equal(guardrail[0].retryable, false);
  assert.equal(guardrail[0].requestedQuestionCount, 10);
  assert.equal(guardrail[0].guardrailId, "gr-abc");
  assert.equal(guardrail[0].guardrailVersion, "3");
  assert.deepEqual(guardrail[0].guardrailFilterTypes, ["PROMPT_ATTACK"]);
  assert.equal(guardrail[0].generatorModel, "amazon.nova-lite-v1:0");
  assert.equal(guardrail[0].validatorModel, "amazon.nova-pro-v1:0");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].failureType, "guardrail_intervened");
});

test("B. guardrail block on a repair round: abort at once, discard the accepted pool, no partial persistence", async () => {
  const generator = generatorFrom((_request, call) => (call === 1 ? makeDraft() : (() => { throw guardrailFailure(); })()));
  const validator = validatorFrom(reviewRejecting(["Question 0"])); // round 1 → 9 accepted
  const { service, repository, events, diagnostics } = serviceWithLogs(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_BLOCKED",
  );

  assert.equal(repository.created.length, 0);
  // round 1 generation + round 2 generation (blocked). No retry of the blocked
  // call, no rounds 3..5, so the operation returns well before maxAttempts.
  assert.equal(generator.calls.length, 2);
  assert.equal(validator.calls.length, 1); // round 1 only
  const guardrail = events.filter((event) => event.event === "AI_GAME_GUARDRAIL_INTERVENED");
  assert.equal(guardrail.length, 1);
  assert.equal(guardrail[0].round, 2);
  assert.equal(guardrail[0].technicalRetry, 0);
  assert.equal(guardrail[0].retryable, false);
  assert.equal(guardrail[0].requestedQuestionCount, 1);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.failureType === "guardrail_intervened").length, 1);
  const serialized = JSON.stringify({ events, diagnostics });
  assert.equal(serialized.includes("Question 0"), false);
  assert.equal(events.some((event) => event.event === "AI_GAME_GENERATION_EXHAUSTED"), false);
});

test("B2. a transient provider fault still gets its bounded technical retry and can recover", async () => {
  // first call → throttling-style transport fault; retry in the SAME round succeeds.
  const generator = generatorFrom((_request, call) => {
    if (call === 1) throw new Error("ThrottlingException: rate exceeded");
    return makeDraft();
  });
  const { service, repository, events, diagnostics } = serviceWithLogs(generator, validatorFrom());

  const game = await service.generate(generateCommand);

  assert.deepEqual(repository.created, [game]);
  assert.equal(game.questions.length, 10);
  assert.equal(generator.calls.length, 2); // 1 initial + 1 same-round technical retry
  assert.equal(events.some((event) => event.event === "AI_GAME_GUARDRAIL_INTERVENED"), false);
  const attempts = events.filter((event) => event.event === "AI_GAME_GENERATION_ATTEMPT" && event.round === 1);
  assert.deepEqual(attempts.map((event) => event.technicalRetry), [0, 1]);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.failureType), ["provider_error"]);
});

test("C. five content-repair rounds progressively assemble exactly ten questions", async () => {
  // r1: 3 accepted / 7 rejected. r2: 3 of 7. r3: 2 of 4. r4: 1 of 2. r5: 1 of 1.
  const generator = generatorFrom((request, call) => {
    if (call === 1) return makeDraft();
    return draftWithQuestionTexts(Array.from({ length: request.questionCount }, (_, index) => `R${call} q${index}`));
  });
  const validator = validatorFrom((request, call) => {
    // reject a shrinking number of the newest candidates each round
    const rejectFirst = call === 1 ? 7 : call === 2 ? 4 : call === 3 ? 2 : call === 4 ? 1 : 0;
    return {
      issues: [],
      questions: request.draft.questions.map((question, index) => ({
        questionIndex: index,
        answerIndex: index < rejectFirst
          ? (generatorAnswerIndex(question) + 1) % question.answers.length
          : generatorAnswerIndex(question),
        confident: true,
        ambiguous: false,
        issues: [],
      })),
    };
  });
  const { service, repository, events } = serviceWithLogs(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(game.questions.length, 10);
  assert.equal(new Set(game.questions.map((question) => question.text)).size, 10);
  assert.deepEqual(repository.created, [game]);
  const repairRounds = events.filter((event) => event.event === "AI_GAME_REPAIR_ROUND");
  assert.deepEqual(repairRounds.map((event) => event.acceptedCount), [3, 3, 2, 1, 1]);
  assert.deepEqual(repairRounds.map((event) => event.missingCount), [7, 4, 2, 1, 0]);
});

test("D. repository.create is called exactly once and only after ten validated questions", async () => {
  const generator = generatorFrom((_request, call) => (call === 1 ? makeDraft() : draftWithQuestionTexts(["one more"])));
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const { service, repository } = serviceWithLogs(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(repository.created.length, 1);
  assert.equal(repository.created[0], game);
  assert.equal(repository.created[0].questions.length, 10);
});

test("E. AI_GAME_REPAIR_ROUND separates generated / accepted / rejected-question / issue counts", async () => {
  // round 1: 10 generated; 3 accepted; 7 rejected questions carrying 11 issues total.
  const generator = generatorFrom(() => makeDraft());
  const validator = validatorFrom((request, call) => {
    if (call !== 1) return disagreeingReview(request);
    return {
      issues: [],
      questions: request.draft.questions.map((question, index) => {
        if (index < 3) {
          return { questionIndex: index, answerIndex: generatorAnswerIndex(question), confident: true, ambiguous: false, issues: [] };
        }
        // rejected: index 3..6 carry 2 issues each (FACTUAL_UNCERTAINTY + AMBIGUOUS_QUESTION), 7..9 carry 1
        return {
          questionIndex: index,
          answerIndex: null,
          confident: false,
          ambiguous: index >= 3 && index <= 6,
          issues: [],
        };
      }),
    };
  });
  const { service, events } = serviceWithLogs(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError,
  );

  const round1 = events.find((event) => event.event === "AI_GAME_REPAIR_ROUND" && event.round === 1);
  assert.ok(round1);
  assert.equal(round1.generatedCount, 10);
  assert.equal(round1.acceptedCount, 3);
  assert.equal(round1.rejectedQuestionCount, 7);
  assert.equal(round1.issueCount, 11); // 4 questions × 2 issues + 3 questions × 1 issue
});

test("batch-size bug fix: 9 accepted + 1 missing → generator asked for exactly 1, one question back, persisted", async () => {
  const generator = generatorFrom((request, call) => {
    if (call === 1) return makeDraft(request.questionCount); // 10 → 9 accepted (Question 0 rejected)
    return draftWithQuestionTexts(
      Array.from({ length: request.questionCount }, (_unused, index) => `repair replacement ${index}`),
    );
  });
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const { service, repository, events } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  // The repair round asked the generator for exactly the missing count, not 10.
  assert.equal(generator.calls.length, 2);
  assert.equal(generator.calls[1].questionCount, 1);
  // The generator returned exactly one candidate and the validator saw exactly one.
  assert.equal(validator.calls[1].draft.questions.length, 1);
  // Final game is exactly ten accepted questions, persisted once.
  assert.equal(game.questions.length, 10);
  assert.deepEqual(repository.created, [game]);
  const repair2 = events.filter((event) => event.event === "AI_GAME_REPAIR_ROUND")[1];
  assert.equal(repair2.requestedQuestionCount, 1);
  assert.equal(repair2.generatedCount, 1);
  assert.equal(repair2.acceptedCount, 1);
  assert.equal(repair2.missingCount, 0);
  const succeeded = events.at(-1);
  assert.equal(succeeded?.event, "AI_GAME_VALIDATION_SUCCEEDED");
  assert.equal(succeeded?.acceptedQuestionCount, 10);
});

test("batch-size bug fix: a 10-question response to a 1-question repair is rejected, never trimmed", async () => {
  const diagnostics: GenerationFailureDiagnostic[] = [];
  const events: GenerationPipelineEvent[] = [];
  const generator = generatorFrom((_request, call) => {
    if (call === 1) return makeDraft(); // 10 → 9 accepted
    return makeDraft(10); // repair round ignores the batch size and over-generates
  });
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const service = new GenerateGameService(generator, validator, new StubGameRepository(), new StubPlayerRepository(), {
    enabled: true,
    createId: () => "123e4567-e89b-12d3-a456-426614174000",
    logEvent: (event) => events.push(event),
    logDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATED_CONTENT_INVALID",
  );

  // Every repair round asked for 1 and got 10; each is rejected whole (0 accepted),
  // never silently trimmed to the first question.
  const repairRounds = events.filter((event) => event.event === "AI_GAME_REPAIR_ROUND");
  for (const round of repairRounds.slice(1)) {
    assert.equal(round.requestedQuestionCount, 1);
    assert.equal(round.generatedCount, 10); // the real over-generation stays visible
    assert.equal(round.acceptedCount, 0);
  }
  // The mismatch is logged as a dedicated validation rule for CloudWatch.
  assert.ok(diagnostics.some((diagnostic) => diagnostic.failureType === "validation_failed"
    && diagnostic.validationRule === "unexpected_question_count"));
  assert.ok(events.some((event) => event.event === "AI_GAME_VALIDATION_REJECTED"
    && (event.issueTypes ?? []).includes("unexpected_question_count")));
});

test("the final game is always exactly ten accepted questions before persistence", async () => {
  const generator = generatorFrom((request) => makeDraft(request.questionCount));
  const validator = validatorFrom(agreeingReview);
  const { service, repository } = serviceWith(generator, validator);

  const game = await service.generate(generateCommand);

  assert.equal(game.questions.length, 10);
  assert.equal(repository.created[0].questions.length, 10);
});

test("repair 7: a Nova Pro technical failure during a repair round fails closed, repository 0", async () => {
  const generator = generatorFrom((_request, call) => (call === 1 ? makeDraft() : draftWithQuestionTexts(["late replacement"])));
  const validator = validatorFrom((_request, call) => {
    if (call === 1) return reviewRejecting(["Question 0"])(_request);
    throw new GameValidatorError();
  });
  const { service, repository } = serviceWith(generator, validator);

  await assert.rejects(
    service.generate(generateCommand),
    (error: unknown) => error instanceof ApplicationError && error.code === "AI_GENERATION_FAILED",
  );

  assert.equal(repository.created.length, 0);
  assert.equal(validator.calls.length, 2);
});

test("the original topic, difficulty, age and category identity are preserved across repair rounds", async () => {
  const generator = generatorFrom((_request, call) => (call === 1 ? makeDraft() : draftWithQuestionTexts(["fresh"])));
  const validator = validatorFrom(reviewRejecting(["Question 0"]));
  const { service } = serviceWith(generator, validator);

  const game = await service.generate({ topic: "Pokémon", difficulty: "easy", questionCount: 10, playerId: "amelia" });

  for (const call of generator.calls) {
    assert.equal(call.topic, "Pokémon");
    assert.equal(call.difficulty, "easy");
    assert.equal(call.targetAge, 4);
  }
  assert.equal(game.category.id, "pokemon");
  assert.ok(game.questions.every((question) => question.categoryId === "pokemon"));
});
