import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameDraft,
  type GenerateGameRequest,
  type GameGenerator,
  type GenerationFailureType,
  type GenerationValidationRule,
  type PreviousGenerationIssue,
} from "../../application/game/GameGenerator.ts";
import {
  buildGuardedUserContent,
  readGuardrailAssessment,
  stripCompleteOuterFence,
  type BedrockSendClient,
  type GuardrailAssessmentEntry,
} from "./bedrockConverse.ts";

const structureExample = `{"title":"Números para peques","difficulty":"easy","category":{"id":"numeros","name":"Números","description":"Juegos cortos para practicar números y conteo.","icon":"🔢"},"questions":[{"id":"q1","categoryId":"numeros","difficulty":"easy","text":"¿Cuántos son 2 + 1?","emoji":"➕","answers":[{"id":"q1a1","text":"3","isCorrect":true},{"id":"q1a2","text":"2","isCorrect":false},{"id":"q1a3","text":"4","isCorrect":false},{"id":"q1a4","text":"5","isCorrect":false}]},{"id":"q2","categoryId":"numeros","difficulty":"easy","text":"¿Qué número sigue después del 4?","answers":[{"id":"q2a1","text":"5","isCorrect":true},{"id":"q2a2","text":"3","isCorrect":false},{"id":"q2a3","text":"6","isCorrect":false},{"id":"q2a4","text":"2","isCorrect":false}]}]}`;

/** How many questions THIS call must return (the batch size), not the final game size. */
const finalGameQuestionCount = 10;

/**
 * The system prompt, parameterized by the requested batch size. Every count in
 * the batch-size rules is `${count}` — the constant 10 (the FINAL game size) is
 * never used to constrain a repair call.
 */
function buildSystemPrompt(count: number): string {
  const many = count >= 4;
  const questionsPhrase = count === 1 ? "1 question" : `${count} questions`;
  const diversityRule = many
    ? `The ${count} questions must be meaningfully diverse. Use at least 4 different question or reasoning types within the set. Do not use the same question template or pattern more than twice. Do not create near-duplicate questions by only changing the numbers, names, or nouns. Each question should feel distinct from the others even though they share one topic.`
    : `Each of the ${questionsPhrase} must feel distinct. Do not reuse the same question template, and do not create near-duplicate questions by only changing the numbers, names, or nouns.`;
  const uniquenessCheck = count === 1
    ? `Before returning the JSON, internally verify that the question has 4 distinct answer texts and exactly one correct answer; if a check fails, revise until it passes.`
    : `Before returning the JSON, internally verify that there are ${count} unique question texts, that every question has 4 distinct answer texts, and that every question has exactly one correct answer; if any check fails, revise the content until it passes.`;

  return `You generate simple, family-friendly educational quiz games for children.
Write all player-facing content in Latin American Spanish.
Return exactly ${questionsPhrase} with exactly 4 answers per question and exactly one correct answer.
Every question must be factual, non-ambiguous, non-subjective, age-appropriate, and educational.
Do not use English onomatopoeia such as boom, splash, or wow.
Never produce sexual content, graphic violence, hate or harassment, dangerous instructions, or requests for private personal information.
Good factual example: "Which planet do we live on?" has one verifiable answer.
Bad ambiguous example: "Which animal is best?" is subjective and must not be used.
Return JSON only. Do not use Markdown fences, prose, explanations, or chain-of-thought.
The JSON object must contain title, difficulty, category, and questions. Each category contains id, name, description, and icon. Each question contains id, categoryId, difficulty, text, optional emoji or image, and answers. Each answer contains id, text, and isCorrect.
The "questions" array must contain exactly ${count} ${count === 1 ? "element" : "elements"}.
Every one of these fields is REQUIRED and must be present and non-empty: title, difficulty, category, category.id, category.name, category.description, category.icon, questions, question.id, question.categoryId, question.difficulty, question.text, answers, answer.id, answer.text, answer.isCorrect.
category.id must be a short lowercase ASCII slug using only letters, digits, and hyphens.
category.icon must be a single emoji.
Every question.categoryId must equal category.id exactly.
answer.isCorrect must be a JSON boolean, and exactly one answer per question has isCorrect set to true.
${diversityRule}
This diversity must stay appropriate for the target player age and consistent with the requested difficulty; hard stays relative to the target age. For ages 4 through 6, do not introduce more advanced concepts only to add variety, and keep every age restriction that follows below.
For numeric or math topics, draw variety as guidance and not as a rigid schema from: counting, comparison, addition or subtraction, patterns and sequences, simple everyday word problems, estimation or selection, numeric relationships, and age-appropriate numeric logic.
For animals, vary across identification, habitat, feeding, characteristics, simple classification, and behavior. For space, vary across planets, objects, positions, characteristics, and exploration. For any other topic, spread the questions across different subtopics or ways of reasoning.
${count === 1 ? "Every question text must be unique." : `Every question text must be unique across the ${count} questions.`} Within one question, no two answer texts may be identical. Prefer every answer text to be unique across the whole game when practical. Do not reuse the same sentence with only minor wording changes.
${uniquenessCheck}
The following is a structure example only; actual output must still contain exactly ${questionsPhrase}:
${structureExample}`;
}

interface BedrockGameGeneratorConfig {
  modelId: string;
  guardrailIdentifier: string;
  guardrailVersion: string;
}

interface ConverseResponse {
  stopReason?: unknown;
  output?: {
    message?: {
      content?: unknown[];
    };
  };
}

export class BedrockGameGeneratorError extends Error {
  constructor(message = "AI provider request failed.") {
    super(message);
    this.name = "BedrockGameGeneratorError";
  }
}

export class BedrockGameGenerator implements GameGenerator {
  private readonly client: BedrockSendClient;
  private readonly config: BedrockGameGeneratorConfig;

  constructor(client: BedrockSendClient, config: BedrockGameGeneratorConfig) {
    const modelId = config.modelId.trim();
    const guardrailIdentifier = config.guardrailIdentifier.trim();
    const guardrailVersion = config.guardrailVersion.trim();
    if (!modelId || !guardrailIdentifier || !guardrailVersion) {
      throw new BedrockGameGeneratorError("AI provider configuration is invalid.");
    }
    this.client = client;
    this.config = { modelId, guardrailIdentifier, guardrailVersion };
  }

  async generate(request: GenerateGameRequest): Promise<GeneratedGameDraft> {
    let response: unknown;
    try {
      // Trust boundary: the topic is the only user-controlled free-form input, so
      // it is the only content the input Guardrail assesses. The structured
      // request fields and every repair directive are application-owned and stay
      // OUT of `guardContent` — otherwise the Guardrail reads our own imperative
      // repair instructions ("return exactly N…", "do not repeat…") as a user
      // PROMPT_ATTACK and blocks the round.
      const trustedInstructions = [
        "The text above is the quiz topic. Generate the game for that topic with these settings:",
        JSON.stringify({ difficulty: request.difficulty, questionCount: request.questionCount }),
        ...buildRepairBlocks(request),
      ];

      response = await this.client.send(new ConverseCommand({
        modelId: this.config.modelId,
        system: [{ text: `${buildSystemPrompt(request.questionCount)}\n${ageAwarePrompt(request.targetAge)}` }],
        messages: [{ role: "user", content: buildGuardedUserContent(request.topic, trustedInstructions) }],
        inferenceConfig: { temperature: 0, maxTokens: 4096 },
        guardrailConfig: {
          guardrailIdentifier: this.config.guardrailIdentifier,
          guardrailVersion: this.config.guardrailVersion,
          trace: "enabled",
        },
      }));
    } catch {
      throw new BedrockGameGeneratorError();
    }

    return parseResponse(response, this.config, request.questionCount);
  }
}

/**
 * Extra user-message blocks for a repair round. Kept deliberately minimal and
 * free of instruction-override phrasing ("ignore the rule…") and of any
 * reviewer chain-of-thought or free-form explanation — only the topic, the
 * count, accepted question texts for de-duplication, and stable issue codes.
 */
function buildRepairBlocks(request: GenerateGameRequest): string[] {
  const blocks: string[] = [];
  if (request.questionCount !== finalGameQuestionCount) {
    const count = request.questionCount;
    const plural = count === 1 ? "" : "s";
    blocks.push(
      `The final game contains ${finalGameQuestionCount} questions, but this request is ONLY for ${count} replacement question${plural} for the topic given above. Return a "questions" array with exactly ${count} question${plural} — not ${finalGameQuestionCount}. Keep the same title, category, difficulty, and JSON object shape.`,
    );
  }
  const existing = (request.existingQuestions ?? []).slice(0, 20).map((text) => `- ${text.slice(0, 160)}`);
  if (existing.length > 0) {
    blocks.push(`These questions are already in the quiz. Do not repeat or paraphrase any of them:\n${existing.join("\n")}`);
  }
  const codes = distinctIssueCodes(request.previousIssues);
  if (codes.length > 0) {
    blocks.push(`Avoid these problem types that caused earlier questions to be replaced:\n${codes.map((code) => `- ${code}`).join("\n")}`);
  }
  return blocks;
}

const safeIssueCodePattern = /^[A-Za-z][A-Za-z_]{1,39}$/;

/** Only well-formed application issue codes reach the prompt; free-form text is dropped. */
function distinctIssueCodes(issues: readonly PreviousGenerationIssue[] | undefined): string[] {
  const seen = new Set<string>();
  for (const issue of issues ?? []) {
    if (typeof issue?.type === "string" && safeIssueCodePattern.test(issue.type)) seen.add(issue.type);
  }
  return [...seen].slice(0, 12);
}

function ageAwarePrompt(targetAge: number): string {
  const ageInstruction = `Target player age: ${targetAge} years old. Every question must be appropriate for that age. Interpret the requested difficulty relative to the target age.`;
  if (targetAge >= 4 && targetAge <= 6) {
    return `${ageInstruction}\nFor ages 4 through 6, use small, concrete, developmentally appropriate concepts. Do not use powers or exponents, square roots, algebra, advanced fractions, advanced multiplication or division, or obviously age-inappropriate concepts.`;
  }
  return ageInstruction;
}

function parseResponse(
  value: unknown,
  config: BedrockGameGeneratorConfig,
  expectedQuestionCount: number,
): GeneratedGameDraft {
  if (!value || typeof value !== "object") invalidCandidate("invalid_shape");
  const response = value as ConverseResponse;
  const stopReason = typeof response.stopReason === "string" ? response.stopReason : undefined;
  if (response.stopReason === "guardrail_intervened") {
    invalidCandidate("guardrail_intervened", stopReason, guardrailSummary(value, config));
  }
  if (response.stopReason === "content_filtered") {
    invalidCandidate("content_filtered", stopReason, guardrailSummary(value, config));
  }

  const content = response.output?.message?.content;
  if (!Array.isArray(content)) invalidCandidate("invalid_shape", stopReason);
  const text = content
    .filter((block): block is { text: string } => (
      !!block
      && typeof block === "object"
      && "text" in block
      && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) invalidCandidate("invalid_shape", stopReason);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCompleteOuterFence(text));
  } catch {
    invalidCandidate("invalid_json", stopReason);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidCandidate("invalid_shape", stopReason);
  const candidate = parsed as Record<string, unknown>;
  const questions = candidate.questions;
  if (!Array.isArray(questions)) invalidCandidate("invalid_shape", stopReason);
  // The batch size is authoritative: a call for N must return exactly N questions.
  // A 10-question response to a 1-question repair request is rejected here, not
  // silently trimmed downstream.
  if (questions.length !== expectedQuestionCount) {
    invalidCandidate("validation_failed", stopReason, undefined, "unexpected_question_count");
  }
  return {
    title: candidate.title as GeneratedGameDraft["title"],
    difficulty: candidate.difficulty as GeneratedGameDraft["difficulty"],
    category: candidate.category as GeneratedGameDraft["category"],
    questions: questions as GeneratedGameDraft["questions"],
  };
}

function guardrailSummary(
  response: unknown,
  config: BedrockGameGeneratorConfig,
): { guardrailId: string; guardrailVersion: string; assessments: GuardrailAssessmentEntry[] } {
  return {
    guardrailId: config.guardrailIdentifier,
    guardrailVersion: config.guardrailVersion,
    assessments: readGuardrailAssessment(response),
  };
}

function invalidCandidate(
  failureType: GenerationFailureType,
  stopReason?: string,
  guardrail?: { guardrailId: string; guardrailVersion: string; assessments: GuardrailAssessmentEntry[] },
  validationRule?: GenerationValidationRule,
): never {
  throw new InvalidGeneratedGameCandidateError({
    failureType,
    stopReason,
    ...(validationRule ? { validationRule } : {}),
    ...(guardrail ? { guardrail } : {}),
  });
}
