import assert from "node:assert/strict";
import test from "node:test";

import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import { GameValidatorError, type ValidateGeneratedGameRequest } from "../../application/game/GameValidator.ts";
import { guardedText, trustedTextBlocks } from "./bedrockConverse.ts";
import { BedrockGameValidator } from "./BedrockGameValidator.ts";

function reviewRequest(): ValidateGeneratedGameRequest {
  return {
    topic: "Pokémon",
    difficulty: "easy",
    targetAge: 6,
    draft: {
      title: "Pokémon quiz",
      difficulty: "easy",
      category: { id: "pokemon", name: "Pokémon", description: "Juego IA", icon: "🎮" },
      questions: Array.from({ length: 10 }, (_, questionIndex) => ({
        id: `q-${questionIndex}`,
        categoryId: "pokemon",
        difficulty: "easy" as const,
        text: `Question ${questionIndex}`,
        answers: Array.from({ length: 4 }, (_, answerIndex) => ({
          id: `q-${questionIndex}-a-${answerIndex}`,
          text: `Answer ${questionIndex}-${answerIndex}`,
          isCorrect: answerIndex === 0,
        })),
      })),
    },
  };
}

function textResponse(text: string): object {
  return { stopReason: "end_turn", output: { message: { content: [{ text }] } } };
}

function fullReview(build: (index: number) => object): string {
  return JSON.stringify({ questions: Array.from({ length: 10 }, (_, index) => build(index)), issues: [] });
}

const confidentEntry = (index: number) => ({ questionIndex: index, answerIndex: 0, confident: true, ambiguous: false, issues: [] });

test("sends a BLIND payload with no signal of the generator's marked answer", async () => {
  const commands: unknown[] = [];
  const validator = new BedrockGameValidator({
    send: async (command: unknown) => {
      commands.push(command);
      return textResponse(fullReview(confidentEntry));
    },
  }, { modelId: "amazon.nova-pro-v1:0", guardrailIdentifier: "g", guardrailVersion: "7" });

  await validator.validate(reviewRequest());

  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof ConverseCommand);
  const input = commands[0].input;
  assert.equal(input.modelId, "amazon.nova-pro-v1:0");
  assert.deepEqual(input.inferenceConfig, { temperature: 0, maxTokens: 2048 });
  assert.deepEqual(input.guardrailConfig, { guardrailIdentifier: "g", guardrailVersion: "7" });

  // Trust boundary: only the user-provided topic is inside a guardContent block.
  const content = input.messages?.[0].content;
  assert.deepEqual(guardedText(content), ["Pokémon"]);

  const trusted = trustedTextBlocks(content);
  const wholeMessage = trusted.join("\n");
  for (const forbidden of ["isCorrect", "correct", "correctAnswer", "correctAnswerIndex", "expectedAnswer", "selectedAnswer"]) {
    assert.equal(wholeMessage.includes(forbidden), false, `payload leaked "${forbidden}"`);
  }

  const payloadText = trusted.find((block) => block.trim().startsWith("{")) ?? "";
  const payload = JSON.parse(payloadText);
  assert.equal("topic" in payload, false); // topic lives only in the guarded block
  assert.equal(payload.difficulty, "easy");
  assert.equal(payload.targetAge, 6);
  assert.equal(payload.questions.length, 10);
  assert.deepEqual(Object.keys(payload.questions[0]).sort(), ["answers", "question", "questionIndex"]);
  assert.deepEqual(payload.questions[0].answers, ["Answer 0-0", "Answer 0-1", "Answer 0-2", "Answer 0-3"]);
  assert.equal(JSON.stringify(input).includes("q-0-a-0"), false);
});

test("prompt tells the model to solve independently, not to review a proposed answer", async () => {
  const commands: unknown[] = [];
  const validator = new BedrockGameValidator({
    send: async (command: unknown) => {
      commands.push(command);
      return textResponse(fullReview(confidentEntry));
    },
  }, { modelId: "amazon.nova-pro-v1:0" });

  await validator.validate(reviewRequest());
  const system = (commands[0] as { input: { system?: Array<{ text: string }> } }).input.system?.[0].text ?? "";

  for (const rule of [
    "Independently solve every multiple-choice question",
    "You are NOT reviewing another model's proposed answer",
    "intentionally hidden from you",
    "Never guess",
    "Do not assume that one of the options must be correct",
    "Distinguish direct relationships from indirect relationships",
    "the direct answer is B, not C",
  ]) assert.ok(system.includes(rule), `missing prompt rule: ${rule}`);
  assert.equal(/is the (provided|selected|marked) (correct )?answer correct/i.test(system), false);
});

test("F. trust boundary: only the topic is guardrail-evaluated, the review payload is not, guardrail stays enabled", async () => {
  const commands: unknown[] = [];
  const validator = new BedrockGameValidator({
    send: async (command: unknown) => {
      commands.push(command);
      return textResponse(fullReview(confidentEntry));
    },
  }, { modelId: "amazon.nova-pro-v1:0", guardrailIdentifier: "g", guardrailVersion: "7" });

  await validator.validate(reviewRequest());

  assert.ok(commands[0] instanceof ConverseCommand);
  const input = commands[0].input;
  const content = input.messages?.[0].content;
  // Only the user-provided topic is guarded.
  assert.deepEqual(guardedText(content), ["Pokémon"]);
  // The review instructions and the candidate question/answer texts are NOT guarded.
  const guarded = guardedText(content).join("\n");
  for (const appOwned of ["Independently solve", "Question 0", "Answer 0-0", "questionIndex", "difficulty"]) {
    assert.equal(guarded.includes(appOwned), false, `guardContent leaked application content: ${appOwned}`);
  }
  // Guardrail itself is untouched — still enabled.
  assert.deepEqual(input.guardrailConfig, { guardrailIdentifier: "g", guardrailVersion: "7" });
  // Blind validation preserved: no marked-answer signal anywhere in the request.
  for (const forbidden of ["isCorrect", "correctAnswerIndex", "selectedAnswer"]) {
    assert.equal(JSON.stringify(input).includes(forbidden), false, `request leaked "${forbidden}"`);
  }
});

test("omits the guardrail configuration when it is not fully provided", async () => {
  const commands: Array<{ input: { guardrailConfig?: unknown } }> = [];
  const validator = new BedrockGameValidator({
    send: async (command) => {
      commands.push(command as { input: { guardrailConfig?: unknown } });
      return textResponse(fullReview(confidentEntry));
    },
  }, { modelId: "amazon.nova-pro-v1:0" });

  await validator.validate(reviewRequest());

  assert.equal("guardrailConfig" in commands[0].input, false);
});

test("parses independent per-question results, index-aligned", async () => {
  const validator = new BedrockGameValidator({
    send: async () => textResponse(fullReview((index) => ({
      questionIndex: index,
      answerIndex: index === 3 ? 2 : 0,
      confident: index !== 5,
      ambiguous: index === 7,
      issues: index === 9 ? [{ type: "OFF_TOPIC", reason: "not about the topic" }] : [],
    }))),
  }, { modelId: "amazon.nova-pro-v1:0" });

  const result = await validator.validate(reviewRequest());

  assert.equal(result.questions.length, 10);
  assert.equal(result.questions[3].answerIndex, 2);
  assert.equal(result.questions[5].confident, false);
  assert.equal(result.questions[7].ambiguous, true);
  assert.deepEqual(result.questions[9].issues, [
    { questionIndex: 9, type: "OFF_TOPIC", severity: "error", reason: "not about the topic" },
  ]);
  assert.equal(result.questions[0].answerIndex, 0);
});

test("derives issue severity from the code: structural/factual = error, distractor quality = warning", async () => {
  const validator = new BedrockGameValidator({
    send: async () => fullReviewResponse((index) => (index === 0
      ? {
          questionIndex: 0,
          answerIndex: 0,
          confident: true,
          ambiguous: false,
          issues: [
            { type: "INVALID_OPTIONS", reason: "duplicate options" },
            { type: "WEAK_DISTRACTOR", severity: "error", reason: "distractor is too obvious" },
            { type: "DIFFICULTY_MISMATCH", reason: "feels a bit easy" },
            { type: "TOO_EASY_DISTRACTOR", reason: "clearly not the answer" },
          ],
        }
      : confidentEntry(index))),
  }, { modelId: "amazon.nova-pro-v1:0" });

  const result = await validator.validate(reviewRequest());
  const bySeverity = Object.fromEntries(result.questions[0].issues.map((issue) => [issue.type, issue.severity]));

  assert.equal(bySeverity.INVALID_OPTIONS, "error");
  // the model's own "severity" claim is ignored — a soft code stays a warning
  assert.equal(bySeverity.WEAK_DISTRACTOR, "warning");
  assert.equal(bySeverity.DIFFICULTY_MISMATCH, "warning");
  assert.equal(bySeverity.TOO_EASY_DISTRACTOR, "warning");
});

test("prompt separates factual validity from distractor quality", async () => {
  const commands: unknown[] = [];
  const validator = new BedrockGameValidator({
    send: async (command: unknown) => {
      commands.push(command);
      return textResponse(fullReview(confidentEntry));
    },
  }, { modelId: "amazon.nova-pro-v1:0" });

  await validator.validate(reviewRequest());
  const system = (commands[0] as { input: { system?: Array<{ text: string }> } }).input.system?.[0].text ?? "";

  for (const rule of [
    "Factual correctness and answer uniqueness are STRICT requirements",
    "Distractor quality is NOT a strict requirement",
    "Do NOT reject a question merely because its distractors are easy",
    "simple and obvious distractors are acceptable",
    "INVALID_OPTIONS is a blocking error ONLY for an objective structural defect",
    "NON-BLOCKING quality warnings using WEAK_DISTRACTOR",
    "always include its \"questionIndex\"",
  ]) assert.ok(system.includes(rule), `missing prompt rule: ${rule}`);
});

test("accepts a null answer index and coerces missing booleans to false", async () => {
  const validator = new BedrockGameValidator({
    send: async () => fullReviewResponse((index) => (index === 0
      ? { questionIndex: 0, answerIndex: null, issues: [{ type: "FACTUAL_UNCERTAINTY", reason: "cannot tell" }] }
      : confidentEntry(index))),
  }, { modelId: "amazon.nova-pro-v1:0" });

  const result = await validator.validate(reviewRequest());

  assert.equal(result.questions[0].answerIndex, null);
  assert.equal(result.questions[0].confident, false);
  assert.equal(result.questions[0].ambiguous, false);
});

test("accepts out-of-order question entries by their declared index", async () => {
  const entries = Array.from({ length: 10 }, (_, index) => confidentEntry(index)).reverse();
  const validator = new BedrockGameValidator({
    send: async () => textResponse(JSON.stringify({ questions: entries })),
  }, { modelId: "amazon.nova-pro-v1:0" });

  const result = await validator.validate(reviewRequest());

  assert.deepEqual(result.questions.map((question) => question.questionIndex), Array.from({ length: 10 }, (_, i) => i));
});

test("fails closed on empty, non-JSON, wrong-shape, missing-questions responses", async () => {
  const responses = [
    textResponse(""),
    textResponse("not json"),
    textResponse("[]"),
    textResponse(JSON.stringify({ issues: [] })),
    { stopReason: "end_turn", output: { message: { content: [] } } },
  ];
  for (const response of responses) {
    const validator = new BedrockGameValidator({ send: async () => response }, { modelId: "amazon.nova-pro-v1:0" });
    await assert.rejects(validator.validate(reviewRequest()), (error: unknown) => error instanceof GameValidatorError);
  }
});

test("fails closed when the model returns 9 results for 10 questions", async () => {
  const nine = Array.from({ length: 9 }, (_, index) => confidentEntry(index));
  const validator = new BedrockGameValidator({
    send: async () => textResponse(JSON.stringify({ questions: nine })),
  }, { modelId: "amazon.nova-pro-v1:0" });

  await assert.rejects(validator.validate(reviewRequest()), (error: unknown) => error instanceof GameValidatorError);
});

test("fails closed on an out-of-range answer index", async () => {
  const validator = new BedrockGameValidator({
    send: async () => fullReviewResponse((index) => (index === 4
      ? { questionIndex: 4, answerIndex: 7, confident: true, ambiguous: false, issues: [] }
      : confidentEntry(index))),
  }, { modelId: "amazon.nova-pro-v1:0" });

  await assert.rejects(validator.validate(reviewRequest()), (error: unknown) => error instanceof GameValidatorError);
});

test("fails closed on duplicated question indexes", async () => {
  const entries = Array.from({ length: 10 }, () => confidentEntry(0));
  const validator = new BedrockGameValidator({
    send: async () => textResponse(JSON.stringify({ questions: entries })),
  }, { modelId: "amazon.nova-pro-v1:0" });

  await assert.rejects(validator.validate(reviewRequest()), (error: unknown) => error instanceof GameValidatorError);
});

test("wraps SDK transport failures as a validator error without leaking details", async () => {
  const failure = Object.assign(new Error("secret validator endpoint"), { name: "BedrockTransportFailure" });
  const validator = new BedrockGameValidator({ send: async () => { throw failure; } }, { modelId: "amazon.nova-pro-v1:0" });

  await assert.rejects(validator.validate(reviewRequest()), (error: unknown) => {
    assert.ok(error instanceof GameValidatorError);
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes("secret"), false);
    return true;
  });
});

test("rejects an empty model id", () => {
  assert.throws(
    () => new BedrockGameValidator({ send: async () => ({}) }, { modelId: "  " }),
    (error: unknown) => error instanceof GameValidatorError,
  );
});

function fullReviewResponse(build: (index: number) => object): object {
  return textResponse(JSON.stringify({ questions: Array.from({ length: 10 }, (_, index) => build(index)) }));
}
