import type { ContentBlock, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

/** Minimal structural view of the Bedrock Runtime client used by the AI adapters. */
export interface BedrockSendClient {
  send(command: ConverseCommand): Promise<unknown>;
}

/**
 * Builds a Converse user-message `content` array whose Guardrail evaluation is
 * scoped to genuinely untrusted input.
 *
 * `untrustedUserInput` (the user-provided game topic) goes into a `guardContent`
 * block; every application-owned instruction in `trustedInstructions` goes into a
 * plain `text` block. Per the Converse API contract, once **any** `guardContent`
 * block is present the Guardrail assesses **only** those blocks on input — so our
 * own generation / repair directives (which read like imperative instructions and
 * were being flagged as `PROMPT_ATTACK`) are no longer treated as a user prompt
 * attack, while the topic is still fully assessed. Output assessment on the model
 * response is unaffected and still applies to everything the model generates.
 *
 * The order is: the guarded topic first, then the trusted instructions, so the
 * model still reads the topic as the subject of the request.
 */
export function buildGuardedUserContent(
  untrustedUserInput: string,
  trustedInstructions: readonly string[],
): ContentBlock[] {
  const content: ContentBlock[] = [
    { guardContent: { text: { text: untrustedUserInput, qualifiers: ["guard_content"] } } },
  ];
  for (const instruction of trustedInstructions) content.push({ text: instruction });
  return content;
}

/**
 * Test/inspection helper: the plain application-owned `text` blocks of a Converse
 * `content` array, i.e. everything that is NOT inside a `guardContent` block.
 */
export function trustedTextBlocks(content: readonly ContentBlock[] | undefined): string[] {
  return (content ?? [])
    .filter((block): block is ContentBlock.TextMember => typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text);
}

/**
 * Test/inspection helper: the concatenated text of every `guardContent` block in
 * a Converse `content` array — the only content the input Guardrail assesses.
 */
export function guardedText(content: readonly ContentBlock[] | undefined): string[] {
  const out: string[] = [];
  for (const block of content ?? []) {
    const text = (block as { guardContent?: { text?: { text?: unknown } } }).guardContent?.text?.text;
    if (typeof text === "string") out.push(text);
  }
  return out;
}

interface ConverseResponse {
  stopReason?: unknown;
  output?: {
    message?: {
      content?: unknown[];
    };
  };
}

/**
 * Extracts the concatenated assistant text from a Bedrock Converse response,
 * ignoring non-text blocks (reasoning, images, tool use). Returns an empty
 * string when there is no usable text.
 */
export function readConverseText(response: unknown): { text: string; stopReason?: string } {
  const value = (response ?? {}) as ConverseResponse;
  const stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
  const content = value.output?.message?.content;
  if (!Array.isArray(content)) return { text: "", stopReason };
  const text = content
    .filter((block): block is { text: string } => (
      !!block
      && typeof block === "object"
      && "text" in block
      && typeof (block as { text: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("")
    .trim();
  return { text, stopReason };
}

/** Removes a single complete outer ```json ... ``` fence if the model wrapped its JSON. */
export function stripCompleteOuterFence(value: string): string {
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(value);
  return match ? match[1].trim() : value;
}

export interface GuardrailAssessmentEntry {
  policy: string;
  type: string;
  action: string;
  confidence?: string;
}

/**
 * Reads the Bedrock Converse `trace.guardrail` assessment into a content-free
 * list of which policies/filter types intervened and the action taken. It never
 * reads the flagged word, PII `match`, configured topic `name`, prompt text, or
 * model output — only enumerated tokens. Requires `guardrailConfig.trace:
 * "enabled"` on the request. Returns `[]` when no trace is present.
 */
export function readGuardrailAssessment(response: unknown): GuardrailAssessmentEntry[] {
  const guardrail = (response as { trace?: { guardrail?: unknown } } | undefined)?.trace?.guardrail;
  if (!guardrail || typeof guardrail !== "object") return [];
  const trace = guardrail as { inputAssessment?: unknown; outputAssessments?: unknown };
  const entries: GuardrailAssessmentEntry[] = [];

  const collect = (assessment: unknown): void => {
    if (!assessment || typeof assessment !== "object") return;
    const a = assessment as Record<string, unknown>;

    const contentFilters = (a.contentPolicy as { filters?: unknown } | undefined)?.filters;
    for (const filter of asArray(contentFilters)) {
      push(entries, "contentPolicy", record(filter).type, record(filter).action, record(filter).confidence);
    }
    const topics = (a.topicPolicy as { topics?: unknown } | undefined)?.topics;
    for (const topic of asArray(topics)) {
      push(entries, "topicPolicy", record(topic).type ?? "TOPIC", record(topic).action);
    }
    const pii = (a.sensitiveInformationPolicy as { piiEntities?: unknown } | undefined)?.piiEntities;
    for (const entity of asArray(pii)) {
      push(entries, "sensitiveInformationPolicy", record(entity).type, record(entity).action);
    }
    const regexes = (a.sensitiveInformationPolicy as { regexes?: unknown } | undefined)?.regexes;
    for (const regex of asArray(regexes)) push(entries, "sensitiveInformationPolicy", "REGEX", record(regex).action);
    const customWords = (a.wordPolicy as { customWords?: unknown } | undefined)?.customWords;
    for (const word of asArray(customWords)) push(entries, "wordPolicy", "CUSTOM_WORD", record(word).action);
    const managedWords = (a.wordPolicy as { managedWordLists?: unknown } | undefined)?.managedWordLists;
    for (const word of asArray(managedWords)) push(entries, "wordPolicy", record(word).type ?? "MANAGED_WORD_LIST", record(word).action);
    const grounding = (a.contextualGroundingPolicy as { filters?: unknown } | undefined)?.filters;
    for (const filter of asArray(grounding)) push(entries, "contextualGroundingPolicy", record(filter).type, record(filter).action);
  };

  for (const assessment of Object.values(asRecord(trace.inputAssessment))) collect(assessment);
  for (const list of Object.values(asRecord(trace.outputAssessments))) {
    for (const assessment of asArray(list)) collect(assessment);
  }
  return entries.slice(0, 16);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function push(
  entries: GuardrailAssessmentEntry[],
  policy: string,
  type: unknown,
  action: unknown,
  confidence?: unknown,
): void {
  if (typeof type !== "string" || typeof action !== "string" || !type || !action) return;
  entries.push({ policy, type, action, ...(typeof confidence === "string" && confidence ? { confidence } : {}) });
}
