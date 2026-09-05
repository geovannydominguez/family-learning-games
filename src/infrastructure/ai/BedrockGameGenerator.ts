import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import {
  InvalidGeneratedGameCandidateError,
  type GeneratedGameDraft,
  type GenerateGameRequest,
  type GameGenerator,
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
The JSON object must contain title, difficulty, category, and questions. Each category contains id, name, description, and icon. Each question contains id, categoryId, difficulty, text, optional emoji or image, and answers. Each answer contains id, text, and isCorrect.`;

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
  if (!value || typeof value !== "object") invalidCandidate();
  const response = value as ConverseResponse;
  if (response.stopReason === "guardrail_intervened" || response.stopReason === "content_filtered") {
    invalidCandidate();
  }

  const content = response.output?.message?.content;
  if (!Array.isArray(content)) invalidCandidate();
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
  if (!text) invalidCandidate();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCompleteOuterFence(text));
  } catch {
    invalidCandidate();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidCandidate();
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

function invalidCandidate(): never {
  throw new InvalidGeneratedGameCandidateError();
}
