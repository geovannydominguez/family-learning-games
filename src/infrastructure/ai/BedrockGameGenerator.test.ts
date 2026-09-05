import assert from "node:assert/strict";
import test from "node:test";

import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import { InvalidGeneratedGameCandidateError } from "../../application/game/GameGenerator.ts";
import {
  BedrockGameGenerator,
  BedrockGameGeneratorError,
} from "./BedrockGameGenerator.ts";

const request = { topic: "dinosaurs", difficulty: "easy" as const, questionCount: 10, targetAge: 4 };

function validPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gameId: "provider-controlled-id",
    title: "Dinosaur quiz",
    difficulty: "easy",
    category: { id: "dinosaurs", name: "Dinosaurs", description: "Learn", icon: "🦕" },
    questions: [],
    ...extra,
  };
}

function textResponse(text: string): object {
  return { stopReason: "end_turn", output: { message: { content: [{ text }] } } };
}

test("requires complete model and guardrail configuration", () => {
  const client = { send: async () => textResponse(JSON.stringify(validPayload())) };
  for (const config of [
    { modelId: "", guardrailIdentifier: "guardrail", guardrailVersion: "1" },
    { modelId: "model", guardrailIdentifier: "", guardrailVersion: "1" },
    { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "" },
  ]) {
    assert.throws(
      () => new BedrockGameGenerator(client, config),
      (error: unknown) => error instanceof BedrockGameGeneratorError
        && error.message === "AI provider configuration is invalid.",
    );
  }
});

test("maps the request to guarded deterministic Converse configuration and a child-safe prompt", async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload()));
  } };
  const generator = new BedrockGameGenerator(client, {
    modelId: "model-id",
    guardrailIdentifier: "guardrail-id",
    guardrailVersion: "7",
  });

  await generator.generate(request);

  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof ConverseCommand);
  const input = commands[0].input;
  assert.equal(input.modelId, "model-id");
  assert.deepEqual(input.inferenceConfig, { temperature: 0, maxTokens: 4096 });
  assert.deepEqual(input.guardrailConfig, {
    guardrailIdentifier: "guardrail-id",
    guardrailVersion: "7",
  });
  assert.equal(input.messages?.[0].role, "user");
  assert.deepEqual(JSON.parse(input.messages?.[0].content?.[0].text ?? ""), {
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
  });

  const prompt = input.system?.[0].text ?? "";
  for (const required of [
    "Latin American Spanish",
    "exactly 10 questions",
    "exactly 4 answers",
    "exactly one correct answer",
    "factual",
    "non-ambiguous",
    "non-subjective",
    "English onomatopoeia",
    "sexual content",
    "graphic violence",
    "hate or harassment",
    "dangerous instructions",
    "private personal information",
    "JSON only",
    "Markdown",
    "chain-of-thought",
    "Which planet do we live on?",
    "Which animal is best?",
    "Target player age: 4 years old.",
    "appropriate for that age",
    "relative to the target age",
    "powers or exponents",
    "square roots",
    "algebra",
    "advanced fractions",
    "advanced multiplication or division",
  ]) assert.ok(prompt.includes(required), `missing prompt rule: ${required}`);
  assert.equal(JSON.stringify(input).includes("Amelia"), false);
  assert.equal(JSON.stringify(input).includes("amelia"), false);
  assert.equal(JSON.stringify(input).includes("avatar"), false);
  assert.equal(JSON.stringify(input).includes("family name"), false);
});

test("does not apply young-child restrictions outside ages four through six", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload()));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate({ topic: "space", difficulty: "normal", questionCount: 10, targetAge: 7 });

  const prompt = commands[0].input.system?.[0].text ?? "";
  assert.ok(prompt.includes("Target player age: 7 years old."));
  assert.equal(prompt.includes("powers or exponents"), false);
});

test("parses clean JSON and one complete outer plain or json fence", async () => {
  const payload = JSON.stringify(validPayload());
  for (const text of [payload, `\`\`\`json\n${payload}\n\`\`\``, `\`\`\`\n${payload}\n\`\`\``]) {
    const generator = new BedrockGameGenerator({ send: async () => textResponse(text) }, {
      modelId: "model",
      guardrailIdentifier: "guardrail",
      guardrailVersion: "1",
    });

    const draft = await generator.generate(request);

    assert.equal(draft.title, "Dinosaur quiz");
  }
});

test("extracts only text blocks and ignores provider-controlled gameId", async () => {
  const payload = JSON.stringify(validPayload());
  const generator = new BedrockGameGenerator({
    send: async () => ({
      stopReason: "end_turn",
      output: { message: { content: [{ reasoningContent: { reasoningText: { text: "secret" } } }, { text: payload }] } },
    }),
  }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  const draft = await generator.generate(request);

  assert.equal("gameId" in draft, false);
  assert.deepEqual(Object.keys(draft).sort(), ["category", "difficulty", "questions", "title"]);
});

test("maps malformed, textless, and wrong top-level responses to invalid-candidate", async () => {
  const responses = [
    textResponse("not-json"),
    textResponse("[]"),
    { stopReason: "end_turn", output: { message: { content: [{ image: { format: "png" } }] } } },
  ];

  for (const response of responses) {
    const generator = new BedrockGameGenerator({ send: async () => response }, {
      modelId: "model",
      guardrailIdentifier: "guardrail",
      guardrailVersion: "1",
    });
    await assert.rejects(
      generator.generate(request),
      (error: unknown) => error instanceof InvalidGeneratedGameCandidateError,
    );
  }
});

test("checks guardrail and content filtering stop reasons before parsing", async () => {
  for (const stopReason of ["guardrail_intervened", "content_filtered"]) {
    const generator = new BedrockGameGenerator({ send: async () => ({
      stopReason,
      output: { message: { content: [{ text: "not-json and must not be parsed" }] } },
      trace: { secret: "provider detail" },
    }) }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

    await assert.rejects(
      generator.generate(request),
      (error: unknown) => error instanceof InvalidGeneratedGameCandidateError
        && !error.message.includes("provider detail"),
    );
  }
});

test("sanitizes technical SDK failures without retaining provider details", async () => {
  const failure = Object.assign(new Error("secret endpoint and prompt"), {
    name: "BedrockTransportFailure",
    $metadata: { requestId: "secret-request-id" },
  });
  const generator = new BedrockGameGenerator({ send: async () => { throw failure; } }, {
    modelId: "model",
    guardrailIdentifier: "guardrail",
    guardrailVersion: "1",
  });

  await assert.rejects(generator.generate(request), (error: unknown) => {
    assert.ok(error instanceof BedrockGameGeneratorError);
    assert.equal(error.message, "AI provider request failed.");
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error).includes("secret"), false);
    return true;
  });
});
