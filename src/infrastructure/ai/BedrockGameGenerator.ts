import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameDraft,
  type GenerateGameRequest,
  type GameGenerator,
  type GenerationFailureType,
} from "../../application/game/GameGenerator.ts";

const productPrompt = `You generate simple, family-friendly educational quiz games for children.
Write all player-facing content in Latin American Spanish.
Return exactly 10 questions with exactly 4 answers per question and exactly one correct answer.
Every question must be factual, non-ambiguous, non-subjective, age-appropriate, and educational.
Do not use English onomatopoeia such as boom, splash, or wow.
Never produce sexual content, graphic violence, hate or harassment, dangerous instructions, or requests for private personal information.
Good factual example: "Which planet do we live on?" has one verifiable answer.
Bad ambiguous example: "Which animal is best?" is subjective and must not be used.
Return JSON only. Do not use Markdown fences, prose, explanations, or chain-of-thought.
The JSON object must contain title, difficulty, category, and questions. Each category contains id, name, description, and icon. Each question contains id, categoryId, difficulty, text, optional emoji or image, and answers. Each answer contains id, text, and isCorrect.
Every one of these fields is REQUIRED and must be present and non-empty: title, difficulty, category, category.id, category.name, category.description, category.icon, questions, question.id, question.categoryId, question.difficulty, question.text, answers, answer.id, answer.text, answer.isCorrect.
category.id must be a short lowercase ASCII slug using only letters, digits, and hyphens.
category.icon must be a single emoji.
Every question.categoryId must equal category.id exactly.
answer.isCorrect must be a JSON boolean, and exactly one answer per question has isCorrect set to true.
The 10 questions must be meaningfully diverse. Use at least 4 different question or reasoning types within the set. Do not use the same question template or pattern more than twice. Do not create near-duplicate questions by only changing the numbers, names, or nouns. Each question should feel distinct from the others even though they share one topic.
This diversity must stay appropriate for the target player age and consistent with the requested difficulty; hard stays relative to the target age. For ages 4 through 6, do not introduce more advanced concepts only to add variety, and keep every age restriction that follows below.
For numeric or math topics, draw variety as guidance and not as a rigid schema from: counting, comparison, addition or subtraction, patterns and sequences, simple everyday word problems, estimation or selection, numeric relationships, and age-appropriate numeric logic.
For animals, vary across identification, habitat, feeding, characteristics, simple classification, and behavior. For space, vary across planets, objects, positions, characteristics, and exploration. For any other topic, spread the questions across different subtopics or ways of reasoning.
The following is a structure example only; actual output must still contain exactly 10 questions:
{"title":"Números para peques","difficulty":"easy","category":{"id":"numeros","name":"Números","description":"Juegos cortos para practicar números y conteo.","icon":"🔢"},"questions":[{"id":"q1","categoryId":"numeros","difficulty":"easy","text":"¿Cuántos son 2 + 1?","emoji":"➕","answers":[{"id":"q1a1","text":"3","isCorrect":true},{"id":"q1a2","text":"2","isCorrect":false},{"id":"q1a3","text":"4","isCorrect":false},{"id":"q1a4","text":"5","isCorrect":false}]},{"id":"q2","categoryId":"numeros","difficulty":"easy","text":"¿Qué número sigue después del 4?","answers":[{"id":"q2a1","text":"5","isCorrect":true},{"id":"q2a2","text":"3","isCorrect":false},{"id":"q2a3","text":"6","isCorrect":false},{"id":"q2a4","text":"2","isCorrect":false}]}]}`;

interface SendClient {
  send(command: ConverseCommand): Promise<unknown>;
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
  private readonly client: SendClient;
  private readonly config: BedrockGameGeneratorConfig;

  constructor(client: SendClient, config: BedrockGameGeneratorConfig) {
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
      response = await this.client.send(new ConverseCommand({
        modelId: this.config.modelId,
        system: [{ text: `${productPrompt}\n${ageAwarePrompt(request.targetAge)}` }],
        messages: [{
          role: "user",
          content: [{ text: JSON.stringify({
            topic: request.topic,
            difficulty: request.difficulty,
            questionCount: request.questionCount,
          }) }],
        }],
        inferenceConfig: { temperature: 0, maxTokens: 4096 },
        guardrailConfig: {
          guardrailIdentifier: this.config.guardrailIdentifier,
          guardrailVersion: this.config.guardrailVersion,
        },
      }));
    } catch {
      throw new BedrockGameGeneratorError();
    }

    return parseResponse(response);
  }
}

function ageAwarePrompt(targetAge: number): string {
  const ageInstruction = `Target player age: ${targetAge} years old. Every question must be appropriate for that age. Interpret the requested difficulty relative to the target age.`;
  if (targetAge >= 4 && targetAge <= 6) {
    return `${ageInstruction}\nFor ages 4 through 6, use small, concrete, developmentally appropriate concepts. Do not use powers or exponents, square roots, algebra, advanced fractions, advanced multiplication or division, or obviously age-inappropriate concepts.`;
  }
  return ageInstruction;
}

function parseResponse(value: unknown): GeneratedGameDraft {
  if (!value || typeof value !== "object") invalidCandidate("invalid_shape");
  const response = value as ConverseResponse;
  const stopReason = typeof response.stopReason === "string" ? response.stopReason : undefined;
  if (response.stopReason === "guardrail_intervened") invalidCandidate("guardrail_intervened", stopReason);
  if (response.stopReason === "content_filtered") invalidCandidate("content_filtered", stopReason);

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
  return {
    title: candidate.title as GeneratedGameDraft["title"],
    difficulty: candidate.difficulty as GeneratedGameDraft["difficulty"],
    category: candidate.category as GeneratedGameDraft["category"],
    questions: candidate.questions as GeneratedGameDraft["questions"],
  };
}

function stripCompleteOuterFence(value: string): string {
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(value);
  return match ? match[1].trim() : value;
}

function invalidCandidate(failureType: GenerationFailureType, stopReason?: string): never {
  throw new InvalidGeneratedGameCandidateError({ failureType, stopReason });
}
