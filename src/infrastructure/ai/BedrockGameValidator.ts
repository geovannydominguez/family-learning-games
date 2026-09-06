import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import {
  GameValidatorError,
  issueSeverity,
  reviewerIssueTypes,
  type GameValidationIssue,
  type GameValidationIssueType,
  type GameValidationResult,
  type GameValidator,
  type IndependentQuestionReview,
  type ValidateGeneratedGameRequest,
} from "../../application/game/GameValidator.ts";
import {
  buildGuardedUserContent,
  readConverseText,
  stripCompleteOuterFence,
  type BedrockSendClient,
} from "./bedrockConverse.ts";

const knownReviewerIssueTypes = new Set<string>(reviewerIssueTypes);
const maxReasonLength = 300;

const validatorSystemPrompt = `You are a strict, independent factual solver and reviewer for a children's multiple-choice quiz game.
You do NOT rewrite, fix, translate, or generate questions.

Independently solve every multiple-choice question.
You are NOT reviewing another model's proposed answer.
The answer selected by the generator is intentionally hidden from you.

For each question:
1. Determine the correct answer yourself from the given options.
2. Return "answerIndex": the zero-based index of the single correct option.
3. If more than one option could reasonably be correct, set "ambiguous": true.
4. If you cannot determine the answer with high confidence, set "confident": false.
5. Never guess.
6. Do not assume that one of the options must be correct.
7. Evaluate factual correctness strictly.

Distinguish direct relationships from indirect relationships.
Example: A evolves into B. B evolves into C. If the question asks what A evolves into, the direct answer is B, not C.

Also review each question for:
- a single correct answer: no second option is also factually correct (MULTIPLE_CORRECT_ANSWERS),
- ambiguity: interpretation, unstated context, opinion, differing versions, edge cases, insufficient information (AMBIGUOUS_QUESTION),
- age appropriateness: reject only if it requires knowledge clearly too advanced for the target age (AGE_INAPPROPRIATE),
- topic relevance to the requested topic (OFF_TOPIC),
- factual uncertainty about the answer (FACTUAL_UNCERTAINTY).
Prefer a false negative over approving a possibly-wrong question.

Factual correctness and answer uniqueness are STRICT requirements.
Distractor quality is NOT a strict requirement. Do NOT reject a question merely because its distractors are easy, obvious, simplistic, very different from the answer, or pedagogically weak. For an educational quiz for young children, and especially for "easy" difficulty, simple and obvious distractors are acceptable; they must not lower "confident" and must not be a blocking issue.
INVALID_OPTIONS is a blocking error ONLY for an objective structural defect: duplicate options, an empty option, the wrong number of options, more than one factually correct option, no factually correct option, or an option so incompatible with the question that the question is malformed.
Weak or too-easy distractors, or a difficulty that feels off, may be reported as NON-BLOCKING quality warnings using WEAK_DISTRACTOR, TOO_EASY_DISTRACTOR, DISTRACTOR_QUALITY or DIFFICULTY_MISMATCH. These never invalidate a question and never lower "confident".

Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{"questions":[{"questionIndex":0,"answerIndex":0,"confident":true,"ambiguous":false,"issues":[]}],"issues":[]}
"answerIndex" is a zero-based integer, or null when you cannot decide.
Each issue is {"type":string,"reason":string}. "type" is one of: ${reviewerIssueTypes.join(", ")}.
"reason" is a short English explanation for logging.
Return exactly one entry in "questions" for every question you were given, in the same order, and always include its "questionIndex".`;

interface BedrockGameValidatorConfig {
  modelId: string;
  guardrailIdentifier?: string;
  guardrailVersion?: string;
}

export class BedrockGameValidator implements GameValidator {
  private readonly client: BedrockSendClient;
  private readonly modelId: string;
  private readonly guardrail?: { guardrailIdentifier: string; guardrailVersion: string };

  constructor(client: BedrockSendClient, config: BedrockGameValidatorConfig) {
    const modelId = config.modelId.trim();
    if (!modelId) throw new GameValidatorError("AI game validator configuration is invalid.");
    this.client = client;
    this.modelId = modelId;
    const guardrailIdentifier = config.guardrailIdentifier?.trim();
    const guardrailVersion = config.guardrailVersion?.trim();
    this.guardrail = guardrailIdentifier && guardrailVersion
      ? { guardrailIdentifier, guardrailVersion }
      : undefined;
  }

  async validate(request: ValidateGeneratedGameRequest): Promise<GameValidationResult> {
    let response: unknown;
    try {
      response = await this.client.send(new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: validatorSystemPrompt }],
        // Same trust boundary as generation: only the user-provided topic is
        // assessed by the input Guardrail. The review payload (candidate question
        // and answer texts, already produced under the generator's output
        // Guardrail) and the review instructions are application-owned and stay
        // out of `guardContent`, so the reviewer prompt is never classified as a
        // user PROMPT_ATTACK.
        messages: [{
          role: "user",
          content: buildGuardedUserContent(request.topic, [
            "The text above is the quiz topic. Independently solve and review the questions in the JSON below for that topic.",
            buildBlindReviewPayload(request),
          ]),
        }],
        inferenceConfig: { temperature: 0, maxTokens: 2048 },
        ...(this.guardrail ? { guardrailConfig: this.guardrail } : {}),
      }));
    } catch {
      throw new GameValidatorError();
    }
    return parseIndependentReview(response, request.draft.questions.map((question) => question.answers.length));
  }
}

/**
 * The payload sent to the model. It deliberately omits every signal of which
 * option the generator marked correct: no `isCorrect`, no `correctAnswerIndex`,
 * no answer ordering hint. Options are plain strings. The topic is NOT repeated
 * here — it is sent once, as the guarded user-input block, and the reviewer reads
 * it from there for the OFF_TOPIC check.
 */
function buildBlindReviewPayload(request: ValidateGeneratedGameRequest): string {
  return JSON.stringify({
    difficulty: request.difficulty,
    targetAge: request.targetAge,
    questions: request.draft.questions.map((question, index) => ({
      questionIndex: index,
      question: question.text,
      answers: question.answers.map((answer) => answer.text),
    })),
  });
}

function parseIndependentReview(response: unknown, answerCounts: number[]): GameValidationResult {
  const { text } = readConverseText(response);
  if (!text) throw new GameValidatorError("The validator returned an empty response.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCompleteOuterFence(text));
  } catch {
    throw new GameValidatorError("The validator returned a non-JSON response.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GameValidatorError("The validator returned an unexpected shape.");
  }

  const record = parsed as { questions?: unknown; issues?: unknown };
  if (!Array.isArray(record.questions)) {
    throw new GameValidatorError("The validator response is missing a 'questions' array.");
  }

  const byIndex = indexReviewEntries(record.questions, answerCounts.length);
  const questions: IndependentQuestionReview[] = answerCounts.map((answerCount, index) =>
    normalizeQuestionReview(byIndex.get(index), index, answerCount));

  return { questions, issues: normalizeIssues(record.issues, -1) };
}

/** Maps each 0..count-1 position to exactly one entry, failing closed on gaps/dupes/out-of-range. */
function indexReviewEntries(entries: unknown[], count: number): Map<number, Record<string, unknown>> {
  if (entries.length !== count) {
    throw new GameValidatorError(`The validator returned ${entries.length} question results for ${count} questions.`);
  }
  const byIndex = new Map<number, Record<string, unknown>>();
  entries.forEach((entry, position) => {
    if (!entry || typeof entry !== "object") {
      throw new GameValidatorError("The validator returned a malformed question result.");
    }
    const record = entry as Record<string, unknown>;
    const declared = record.questionIndex;
    const index = typeof declared === "number" && Number.isInteger(declared) ? declared : position;
    if (index < 0 || index >= count || byIndex.has(index)) {
      throw new GameValidatorError("The validator returned an invalid or duplicated question index.");
    }
    byIndex.set(index, record);
  });
  return byIndex;
}

function normalizeQuestionReview(
  entry: Record<string, unknown> | undefined,
  questionIndex: number,
  answerCount: number,
): IndependentQuestionReview {
  if (!entry) throw new GameValidatorError("The validator omitted a question result.");
  return {
    questionIndex,
    answerIndex: normalizeAnswerIndex(entry.answerIndex, answerCount),
    confident: entry.confident === true,
    ambiguous: entry.ambiguous === true,
    issues: normalizeIssues(entry.issues, questionIndex),
  };
}

function normalizeAnswerIndex(value: unknown, answerCount: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= answerCount) {
    throw new GameValidatorError("The validator returned an out-of-range answer index.");
  }
  return value;
}

function normalizeIssues(value: unknown, questionIndex: number): GameValidationIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: GameValidationIssue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; reason?: unknown };
    const type = normalizeIssueType(candidate.type);
    issues.push({
      questionIndex,
      type,
      // Severity is derived from the code, never from the model's own claim:
      // a hard type can't be downgraded and a soft type can't be escalated.
      severity: issueSeverity(type),
      reason: normalizeReason(candidate.reason),
    });
  }
  return issues;
}

function normalizeIssueType(value: unknown): GameValidationIssueType {
  return typeof value === "string" && knownReviewerIssueTypes.has(value)
    ? (value as GameValidationIssueType)
    : "FACTUAL_UNCERTAINTY";
}

function normalizeReason(value: unknown): string {
  if (typeof value !== "string") return "Unspecified review issue.";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Unspecified review issue.";
  return trimmed.length > maxReasonLength ? `${trimmed.slice(0, maxReasonLength)}…` : trimmed;
}
