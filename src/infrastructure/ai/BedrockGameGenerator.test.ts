import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import type { GenerateGameRequest } from "../../application/game/GameGenerator.ts";
import { InvalidGeneratedGameCandidateError } from "../../application/game/GameGenerator.ts";
import { guardedText, trustedTextBlocks } from "./bedrockConverse.ts";
import {
  BedrockGameGenerator,
  BedrockGameGeneratorError,
} from "./BedrockGameGenerator.ts";

const request = { topic: "dinosaurs", difficulty: "easy" as const, questionCount: 10, targetAge: 4 };

function questionList(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `q${index + 1}`,
    categoryId: "dinosaurs",
    difficulty: "easy",
    text: `Dinosaur question ${index + 1}`,
    answers: [
      { id: `q${index + 1}a1`, text: "A", isCorrect: true },
      { id: `q${index + 1}a2`, text: "B", isCorrect: false },
      { id: `q${index + 1}a3`, text: "C", isCorrect: false },
      { id: `q${index + 1}a4`, text: "D", isCorrect: false },
    ],
  }));
}

/**
 * A structurally complete generator response. `questionCount` MUST match the
 * batch size the generator was asked for — the parser now rejects any other
 * length as `unexpected_question_count`.
 */
function validPayload(questionCount = 10, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gameId: "provider-controlled-id",
    title: "Dinosaur quiz",
    difficulty: "easy",
    category: { id: "dinosaurs", name: "Dinosaurs", description: "Learn", icon: "🦕" },
    questions: questionList(questionCount),
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
    trace: "enabled",
  });
  assert.equal(input.messages?.[0].role, "user");
  // Trust boundary: ONLY the user-provided topic is inside a guardContent block.
  assert.deepEqual(guardedText(input.messages?.[0].content), ["dinosaurs"]);
  assert.deepEqual(input.messages?.[0].content?.[0], {
    guardContent: { text: { text: "dinosaurs", qualifiers: ["guard_content"] } },
  });
  // Application-owned request settings are plain (unguarded) text, not guardContent.
  const trusted = trustedTextBlocks(input.messages?.[0].content);
  assert.ok(trusted.some((block) => {
    try {
      return JSON.stringify(JSON.parse(block)) === JSON.stringify({ difficulty: "easy", questionCount: 10 });
    } catch {
      return false;
    }
  }), "expected an unguarded {difficulty, questionCount} settings block");

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

test("surfaces a content-free guardrail assessment from the Converse trace", async () => {
  const generator = new BedrockGameGenerator({ send: async () => ({
    stopReason: "guardrail_intervened",
    output: { message: { content: [{ text: "blocked" }] } },
    trace: {
      guardrail: {
        modelOutput: ["the raw blocked model text that must never be logged"],
        inputAssessment: {
          "gr-123": {
            contentPolicy: {
              filters: [
                { type: "PROMPT_ATTACK", confidence: "HIGH", filterStrength: "HIGH", action: "BLOCKED" },
                { type: "VIOLENCE", confidence: "LOW", action: "NONE" },
              ],
            },
            sensitiveInformationPolicy: {
              piiEntities: [{ match: "someone@example.com", type: "EMAIL", action: "BLOCKED" }],
            },
            wordPolicy: { customWords: [{ match: "a blocked word", action: "BLOCKED" }] },
          },
        },
      },
    },
  }) }, { modelId: "model", guardrailIdentifier: "gr-123", guardrailVersion: "4" });

  await assert.rejects(generator.generate(request), (error: unknown) => {
    assert.ok(error instanceof InvalidGeneratedGameCandidateError);
    assert.equal(error.failure.failureType, "guardrail_intervened");
    assert.equal(error.failure.guardrail?.guardrailId, "gr-123");
    assert.equal(error.failure.guardrail?.guardrailVersion, "4");
    const assessments = error.failure.guardrail?.assessments ?? [];
    assert.deepEqual(assessments, [
      { policy: "contentPolicy", type: "PROMPT_ATTACK", action: "BLOCKED", confidence: "HIGH" },
      { policy: "contentPolicy", type: "VIOLENCE", action: "NONE", confidence: "LOW" },
      { policy: "sensitiveInformationPolicy", type: "EMAIL", action: "BLOCKED" },
      { policy: "wordPolicy", type: "CUSTOM_WORD", action: "BLOCKED" },
    ]);
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes("someone@example.com"), false);
    assert.equal(serialized.includes("a blocked word"), false);
    assert.equal(serialized.includes("raw blocked model text"), false);
    return true;
  });
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

  // The topic is the only guarded (untrusted) content; the settings ride along
  // as unguarded application text.
  assert.deepEqual(guardedText(commands[0].input.messages?.[0].content), ["dinosaurs"]);
  assert.ok(trustedTextBlocks(commands[0].input.messages?.[0].content).includes(
    JSON.stringify({ difficulty: "easy", questionCount: 10 }),
  ));
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

test("a repair request stays minimal: fewer questions, dedup list, issue codes, no injection phrasing", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload(2)));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate({
    topic: "Pokémon",
    difficulty: "easy",
    questionCount: 2,
    targetAge: 6,
    existingQuestions: ["¿Cuál Pokémon es eléctrico?", "¿Cuántas patas tiene un Caterpie?"],
    previousIssues: [
      { questionIndex: 0, type: "ANSWER_MISMATCH", reason: "the reviewer thinks the marked answer of Pikachu is wrong because…" },
      { questionIndex: 1, type: "AMBIGUOUS_QUESTION", reason: "arbitrary free-form validator explanation with detail" },
      { questionIndex: 2, type: "not a real code, free text", reason: "junk" },
    ],
  });

  const content = commands[0].input.messages?.[0].content ?? [];
  // Trust boundary: only the topic is guarded; every repair directive is unguarded.
  assert.deepEqual(guardedText(content), ["Pokémon"]);
  assert.ok(trustedTextBlocks(content).includes(
    JSON.stringify({ difficulty: "easy", questionCount: 2 }),
  ));
  const blocks = trustedTextBlocks(content).join("\n");

  assert.ok(blocks.includes("this request is ONLY for 2 replacement questions"));
  assert.ok(blocks.includes("Return a \"questions\" array with exactly 2 questions — not 10"));
  assert.ok(blocks.includes("Do not repeat or paraphrase any of them"));
  assert.ok(blocks.includes("¿Cuál Pokémon es eléctrico?")); // accepted question texts, for de-dup only
  assert.ok(blocks.includes("- ANSWER_MISMATCH"));
  assert.ok(blocks.includes("- AMBIGUOUS_QUESTION"));

  // The repair directives must NOT be inside guardContent — that is the bug fix.
  const guarded = guardedText(content).join("\n");
  assert.equal(guarded.includes("replacement question"), false);
  assert.equal(guarded.includes("Do not repeat or paraphrase"), false);
  assert.equal(guarded.includes("ANSWER_MISMATCH"), false);

  // no instruction-override / reviewer / free-form-reason phrasing
  assert.equal(/ignore the/i.test(blocks), false);
  assert.equal(blocks.includes("This is a repair request"), false);
  assert.equal(/reviewer|rejected by|completely new game/i.test(blocks), false);
  assert.equal(blocks.includes("the reviewer thinks the marked answer"), false);
  assert.equal(blocks.includes("arbitrary free-form validator explanation"), false);
  assert.equal(blocks.includes("not a real code"), false); // malformed codes are dropped

  // guardrail trace requested so interventions can be diagnosed
  assert.equal((commands[0].input.guardrailConfig as { trace?: string }).trace, "enabled");
  // the system prompt asks for the batch size of THIS call, not a fixed 10
  assert.ok((commands[0].input.system?.[0].text ?? "").includes("Return exactly 2 questions"));
  assert.equal((commands[0].input.system?.[0].text ?? "").includes("Return exactly 10 questions"), false);
});

test("a repair request never sends answer options or correct-answer metadata for accepted questions", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload(3)));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate({
    topic: "Pokémon",
    difficulty: "easy",
    questionCount: 3,
    targetAge: 6,
    existingQuestions: ["¿De qué tipo es Bulbasaur?", "¿Cuántos ojos tiene un Magikarp?"],
  });

  const payload = (commands[0].input.messages?.[0].content ?? []).map((block) => block.text ?? "").join("\n");
  for (const forbidden of ["isCorrect", "correctAnswer", "correctAnswerIndex", "answers\":", "\"options\""]) {
    assert.equal(payload.includes(forbidden), false, `repair prompt leaked "${forbidden}"`);
  }
  assert.ok(payload.includes("¿De qué tipo es Bulbasaur?"));
});

test("a first-round request (10 questions) adds no repair blocks", async () => {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload()));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await generator.generate(request);

  const content = commands[0].input.messages?.[0].content ?? [];
  // guardContent(topic) + framing line + settings JSON — and nothing else.
  assert.deepEqual(guardedText(content), ["dinosaurs"]);
  const trusted = trustedTextBlocks(content);
  assert.equal(trusted.length, 2);
  assert.ok(trusted.includes(JSON.stringify({ difficulty: "easy", questionCount: 10 })));
  const joined = trusted.join("\n");
  for (const repairPhrase of ["replacement question", "already in the quiz", "Avoid these problem types"]) {
    assert.equal(joined.includes(repairPhrase), false, `first round leaked repair phrase: ${repairPhrase}`);
  }
});

test("the batch size drives both the prompt and the parser for 10, 5, and 1 questions", async () => {
  for (const questionCount of [10, 5, 1]) {
    const commands: ConverseCommand[] = [];
    const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
      commands.push(command);
      return textResponse(JSON.stringify(validPayload(questionCount)));
    } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

    const draft = await generator.generate({ topic: "dinosaurs", difficulty: "easy", questionCount, targetAge: 6 });

    // The system prompt asks for exactly this batch size, never a fixed 10.
    const prompt = commands[0].input.system?.[0].text ?? "";
    const phrase = questionCount === 1 ? "1 question" : `${questionCount} questions`;
    assert.ok(prompt.includes(`Return exactly ${phrase}`), `prompt should request "${phrase}"`);
    assert.ok(prompt.includes(`must contain exactly ${questionCount} `));
    if (questionCount !== 10) {
      assert.equal(prompt.includes("exactly 10 questions"), false, "no fixed-10 language leaks into a repair prompt");
    }
    // The trust boundary is identical for every batch size: topic guarded,
    // settings unguarded, and the settings carry the requested count verbatim.
    const content = commands[0].input.messages?.[0].content;
    assert.deepEqual(guardedText(content), ["dinosaurs"]);
    assert.ok(trustedTextBlocks(content).includes(
      JSON.stringify({ difficulty: "easy", questionCount }),
    ));
    // The parser accepts a response whose length equals the requested count.
    assert.equal(draft.questions.length, questionCount);
  }
});

test("the parser rejects a fixed batch of 10 when only 1 replacement question was requested", async () => {
  const generator = new BedrockGameGenerator({
    send: async () => textResponse(JSON.stringify(validPayload(10))),
  }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await assert.rejects(
    generator.generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 1, targetAge: 6 }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidGeneratedGameCandidateError);
      assert.equal(error.failure.failureType, "validation_failed");
      assert.equal(error.failure.validationRule, "unexpected_question_count");
      return true;
    },
  );
});

test("the parser rejects an under-sized batch too (2 returned for a 5-question request)", async () => {
  const generator = new BedrockGameGenerator({
    send: async () => textResponse(JSON.stringify(validPayload(2))),
  }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "1" });

  await assert.rejects(
    generator.generate({ topic: "dinosaurs", difficulty: "easy", questionCount: 5, targetAge: 6 }),
    (error: unknown) => error instanceof InvalidGeneratedGameCandidateError
      && error.failure.validationRule === "unexpected_question_count",
  );
});

test("no hardcoded generation batch count remains in the generator source", async () => {
  const source = await readFile(new URL("./BedrockGameGenerator.ts", import.meta.url), "utf8");
  // The only literal 10 that may remain is `finalGameQuestionCount`, the FINAL
  // game size used to phrase the repair contrast ("...but this request is only
  // for N..."). Nothing may pin the generated batch to 10.
  assert.equal(/questions\.length === 10\b/.test(source), false);
  assert.equal(/questionCount = 10\b/.test(source), false);
  assert.match(source, /const finalGameQuestionCount = 10;/);
  assert.match(source, /buildSystemPrompt\(request\.questionCount\)/);
  assert.match(source, /parseResponse\(response, this\.config, request\.questionCount\)/);
});

// --- Guardrail trust boundary: only untrusted user input is guardrail-evaluated ---

function captureGenerate(overrides: Partial<GenerateGameRequest> = {}) {
  const commands: ConverseCommand[] = [];
  const generator = new BedrockGameGenerator({ send: async (command: ConverseCommand) => {
    commands.push(command);
    return textResponse(JSON.stringify(validPayload(overrides.questionCount ?? request.questionCount)));
  } }, { modelId: "model", guardrailIdentifier: "guardrail", guardrailVersion: "3" });
  return { commands, run: () => generator.generate({ ...request, ...overrides }) };
}

test("A. application-owned repair instructions are NOT inside guardContent", async () => {
  const { commands, run } = captureGenerate({
    topic: "Pokémon",
    questionCount: 6,
    existingQuestions: ["¿Cuál Pokémon es de tipo fuego?"],
    previousIssues: [{ questionIndex: 0, type: "ANSWER_MISMATCH", reason: "x" }],
  });
  await run();

  const guarded = guardedText(commands[0].input.messages?.[0].content).join("\n");
  for (const appDirective of [
    "replacement question",
    "Return a \"questions\" array with exactly",
    "Do not repeat or paraphrase any of them",
    "¿Cuál Pokémon es de tipo fuego?",
    "Avoid these problem types",
    "ANSWER_MISMATCH",
    "difficulty",
    "questionCount",
  ]) {
    assert.equal(guarded.includes(appDirective), false, `guardContent leaked application directive: ${appDirective}`);
  }
});

test("B. the user-controlled topic IS the guardContent, and it is the only guarded block", async () => {
  const { commands, run } = captureGenerate({ topic: "Pokémon", questionCount: 6 });
  await run();

  assert.deepEqual(guardedText(commands[0].input.messages?.[0].content), ["Pokémon"]);
  assert.deepEqual(commands[0].input.messages?.[0].content?.[0], {
    guardContent: { text: { text: "Pokémon", qualifiers: ["guard_content"] } },
  });
});

test("C. initial and repair generation apply the identical trust boundary", async () => {
  const initial = captureGenerate({ topic: "Space", questionCount: 10 });
  await initial.run();
  const repair = captureGenerate({
    topic: "Space",
    questionCount: 6,
    existingQuestions: ["Q kept 1", "Q kept 2"],
    previousIssues: [{ questionIndex: 0, type: "OFF_TOPIC", reason: "y" }],
  });
  await repair.run();

  for (const commands of [initial.commands, repair.commands]) {
    const content = commands[0].input.messages?.[0].content;
    // topic guarded, exactly one guarded block, settings unguarded
    assert.deepEqual(guardedText(content), ["Space"]);
    assert.equal(
      (content ?? []).filter((block) => "guardContent" in (block as object)).length,
      1,
    );
    assert.ok(trustedTextBlocks(content).some((block) => block.includes("\"questionCount\"")));
  }
});

test("D. the Guardrail stays fully enabled (id, version, trace) for every round", async () => {
  for (const questionCount of [10, 6, 1]) {
    const { commands, run } = captureGenerate({ topic: "Animales", questionCount });
    await run();
    assert.deepEqual(commands[0].input.guardrailConfig, {
      guardrailIdentifier: "guardrail",
      guardrailVersion: "3",
      trace: "enabled",
    });
  }
});

test("E. a repair request for questionCount=6 does not mark the whole repair prompt as guarded", async () => {
  const { commands, run } = captureGenerate({
    topic: "Pokémon",
    questionCount: 6,
    existingQuestions: ["A", "B", "C"],
    previousIssues: [
      { questionIndex: 0, type: "ANSWER_MISMATCH", reason: "r" },
      { questionIndex: 1, type: "AMBIGUOUS_QUESTION", reason: "r" },
    ],
  });
  await run();

  const content = commands[0].input.messages?.[0].content ?? [];
  const guardedChars = guardedText(content).join("").length;
  const trustedChars = trustedTextBlocks(content).join("").length;
  // The guarded portion is just the topic; the bulk of the prompt is trusted.
  assert.equal(guardedText(content).join(""), "Pokémon");
  assert.ok(trustedChars > guardedChars * 5, "the repair directives must dominate the UNGUARDED portion");
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
