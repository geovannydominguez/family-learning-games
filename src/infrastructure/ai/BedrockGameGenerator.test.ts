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

test("tags invalid candidates with a safe internal failure type and stop reason only", async () => {
  const scenarios: Array<{ response: object; failureType: string; stopReason?: string }> = [
    {
      response: {
        stopReason: "guardrail_intervened",
        output: { message: { content: [{ text: "must not be parsed" }] } },
        trace: { secret: "provider detail" },
      },
      failureType: "guardrail_intervened",
      stopReason: "guardrail_intervened",
    },
    {
      response: {
        stopReason: "content_filtered",
        output: { message: { content: [{ text: "must not be parsed" }] } },
      },
      failureType: "content_filtered",
      stopReason: "content_filtered",
    },
    {
      response: { stopReason: "max_tokens", output: { message: { content: [{ text: "{ truncated json" }] } } },
      failureType: "invalid_json",
      stopReason: "max_tokens",
    },
    { response: textResponse("[]"), failureType: "invalid_shape", stopReason: "end_turn" },
    {
      response: { stopReason: "end_turn", output: { message: { content: [{ image: { format: "png" } }] } } },
      failureType: "invalid_shape",
      stopReason: "end_turn",
    },
  ];

  for (const scenario of scenarios) {
    const generator = new BedrockGameGenerator({ send: async () => scenario.response }, {
      modelId: "model",
      guardrailIdentifier: "guardrail",
      guardrailVersion: "1",
    });

    await assert.rejects(generator.generate(request), (error: unknown) => {
      assert.ok(error instanceof InvalidGeneratedGameCandidateError);
      assert.equal(error.failure.failureType, scenario.failureType);
      assert.equal(error.failure.stopReason, scenario.stopReason);
      assert.equal("validationRule" in error.failure, false);
      assert.equal("validationField" in error.failure, false);
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes("provider detail"), false);
      assert.equal(serialized.includes("truncated json"), false);
      return true;
    });
  }
});

test("system prompt states every required field, the slug/emoji rules, and a coherent JSON example", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload()));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate(request);
  const prompt = commands[0].input.system?.[0].text ?? "";

  for (const rule of [
    "Every one of these fields is REQUIRED and must be present and non-empty",
    "title, difficulty, category, category.id, category.name, category.description, category.icon",
    "questions, question.id, question.categoryId, question.difficulty, question.text",
    "answers, answer.id, answer.text, answer.isCorrect",
    "category.id must be a short lowercase ASCII slug",
    "category.icon must be a single emoji",
    "Every question.categoryId must equal category.id exactly",
    "structure example only; actual output must still contain exactly 10 questions",
  ]) assert.ok(prompt.includes(rule), `missing prompt rule: ${rule}`);

  // The embedded example is the single line right after the marker.
  const marker = "exactly 10 questions:\n";
  const exampleLine = prompt.slice(prompt.indexOf(marker) + marker.length).split("\n")[0];
  const example = JSON.parse(exampleLine) as {
    title: string;
    difficulty: string;
    category: { id: string; name: string; description: string; icon: string };
    questions: Array<{
      id: string;
      categoryId: string;
      difficulty: string;
      text: string;
      answers: Array<{ id: string; text: string; isCorrect: boolean }>;
    }>;
  };

  assert.ok(example.title.length > 0);
  assert.match(example.category.id, /^[a-z0-9-]+$/);
  assert.ok(example.category.name.length > 0);
  assert.ok(example.category.description.length > 0);
  assert.ok(example.category.icon.length > 0);
  assert.ok(example.questions.length >= 1);
  for (const question of example.questions) {
    assert.equal(question.categoryId, example.category.id);
    assert.equal(question.answers.length, 4);
    assert.equal(question.answers.filter((answer) => answer.isCorrect === true).length, 1);
    for (const answer of question.answers) assert.equal(typeof answer.isCorrect, "boolean");
  }

  // The user message is unchanged: still exactly { topic, difficulty, questionCount }.
  assert.deepEqual(JSON.parse(commands[0].input.messages?.[0].content?.[0].text ?? ""), {
    topic: "dinosaurs",
    difficulty: "easy",
    questionCount: 10,
  });
});

test("system prompt requires meaningful intra-game diversity across the 10 questions", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload()));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate(request);
  const prompt = commands[0].input.system?.[0].text ?? "";

  for (const rule of [
    "The 10 questions must be meaningfully diverse",
    "at least 4 different question or reasoning types",
    "Do not use the same question template or pattern more than twice",
    "Do not create near-duplicate questions by only changing the numbers, names, or nouns",
    "This diversity must stay appropriate for the target player age",
    "hard stays relative to the target age",
    "For ages 4 through 6, do not introduce more advanced concepts only to add variety",
    "For numeric or math topics, draw variety",
    "For animals, vary across identification, habitat, feeding",
    "For space, vary across planets, objects, positions",
  ]) assert.ok(prompt.includes(rule), `missing diversity rule: ${rule}`);

  // Diversity rules do not enlarge the structure example (still 2 questions).
  const marker = "exactly 10 questions:\n";
  const exampleLine = prompt.slice(prompt.indexOf(marker) + marker.length).split("\n")[0];
  const example = JSON.parse(exampleLine) as { questions: unknown[] };
  assert.equal(example.questions.length, 2);

  // The young-child hard restrictions are untouched.
  assert.ok(prompt.includes("powers or exponents"));
  assert.ok(prompt.includes("Target player age: 4 years old."));
});

test("system prompt forbids duplicate question and answer texts and asks for a pre-return check", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload()));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate(request);
  const prompt = commands[0].input.system?.[0].text ?? "";

  for (const rule of [
    "Every question text must be unique across the 10 questions",
    "no two answer texts may be identical",
    "Prefer every answer text to be unique across the whole game when practical",
    "Do not reuse the same sentence with only minor wording changes",
    "Before returning the JSON, internally verify that there are 10 unique question texts",
    "every question has 4 distinct answer texts",
    "every question has exactly one correct answer",
  ]) assert.ok(prompt.includes(rule), `missing uniqueness rule: ${rule}`);

  // The intra-game diversity rules from the previous change are still present.
  assert.ok(prompt.includes("The 10 questions must be meaningfully diverse"));
  assert.ok(prompt.includes("Do not create near-duplicate questions by only changing the numbers, names, or nouns"));

  // The structure example was not enlarged.
  const marker = "exactly 10 questions:\n";
  const exampleLine = prompt.slice(prompt.indexOf(marker) + marker.length).split("\n")[0];
  assert.equal((JSON.parse(exampleLine) as { questions: unknown[] }).questions.length, 2);
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
