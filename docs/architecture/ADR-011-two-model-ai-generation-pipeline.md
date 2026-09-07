# ADR-011 — Two-model pipeline for AI-generated games (Nova Lite drafts, Nova Pro blind-solves)

## Status

Accepted. Extends ADR-008 (Amazon Bedrock behind `GameGenerator`) and ADR-009
(validate AI-generated games before persistence). Supersedes nothing.

**Revision 1:** the validation step performs **blind independent answer
resolution**. The generator-selected correct answer is not sent to Nova Pro;
Nova Pro independently solves each question; Application deterministically
compares the two answers; a mismatch rejects the question. The LLM has no final
authority over persistence.

**Revision 2:** issue codes are split into blocking `error` severities (factual /
structural) and non-blocking `warning` severities (distractor quality), decided
by Application from the code. Easy distractors in a young-children "easy" quiz
are not a failure.

**Revision 9 (bug fix, not architecture):** repair rounds now feed the generator
the text of **every question seen so far this operation** — accepted, rejected by
Nova Pro, rejected deterministically, or generated in an earlier round and then
discarded — not just the accepted pool. Application keeps a monotonically growing
`seen` map (normalized key → first original text) alongside the accepted pool;
`existingQuestions` on the repair request is built from `seen.values()`. The
repair prompt block is firmer ("Generate exactly N NEW questions… do NOT repeat,
rephrase, translate, reorder the options of, or make a trivial variant of any
question below… each new question must cover a distinct fact or angle"). The
deterministic `duplicate_text` guard is unchanged in responsibility (it still
compares only against the **accepted** pool and the current round) but its
comparison key is now normalized (case, accents, surrounding punctuation,
collapsed whitespace) so trivial variants collide. Rationale: on a narrow topic
("Mundiales de Futbol", easy) round 1 accepted 8 and rejected 2, but the
generator only ever saw the 8, so every repair round it re-emitted questions that
`duplicate_text` then rejected until `AI_GAME_GENERATION_EXHAUSTED` / 422. New
observability field `seenQuestionCount` on `AI_GAME_GENERATION_ATTEMPT` and
`AI_GAME_REPAIR_ROUND` (count only, no texts). `accepted` is still the only source
of the final game; a rejected question never joins it. No change to models,
ports, HTTP contracts, Guardrail, `guardrail_intervened` handling, technical
retries, `MAX_REPAIR_ROUNDS`, or the Lambda timeout.

**Revision 8 (bug fix, not architecture):** a Bedrock Guardrail intervention
(`stopReason = "guardrail_intervened"` / `content_filtered`) is now classified as
a **deterministic policy decision**, not a transient technical fault. It no longer
consumes a same-round technical retry and no longer lets the repair loop continue:
the block is recorded once (`ai_generation_failure` diagnostic +
`AI_GAME_GUARDRAIL_INTERVENED` event, now carrying `retryable: false`) and the
whole operation finalizes immediately with a new application error
`AI_GENERATION_BLOCKED` → **HTTP 422**, `GameRepository.create` count 0. Rationale:
generation runs at `temperature: 0` and the block is driven by the request/topic
itself (e.g. World-Cup topics whose output trips `sensitiveInformationPolicy` /
`ADDRESS`), so an identical immediate retry — and every further repair round —
is blocked the same way; the previous behaviour issued ~10 identical blocked
Bedrock calls and drove the Lambda to its 28 s timeout. `provider_error`
(throttling / transport / retriable 5xx) and malformed output
(`invalid_json` / `invalid_shape`) keep their one bounded same-round technical
retry. Guardrail infrastructure, both models, ports, and the repair/validation
pipeline are unchanged. The frontend maps `AI_GENERATION_BLOCKED` to a friendly
Spanish message; guardrail id/version/policy/filter tokens stay in observability
only and never reach the browser.

**Revision 3:** retries are **question-level repair rounds**, not whole-draft
regeneration. Valid questions are kept; only failed slots are re-requested.
`GameRepository.create` is still called exactly once, only after ten unique valid
questions exist.

**Revision 4:** content-repair rounds and technical retries are separated. The
content-repair budget is `MAX_REPAIR_ROUNDS = 5`; a round is consumed only when
generation yields candidates that can be evaluated. A failure that produces **no
candidate content** (guardrail block, transport error, malformed response) gets a
bounded same-round retry first: `MAX_TECHNICAL_RETRIES_PER_ROUND = 1`, retrying
the SAME repair round. A `provider_error` that also fails its retry fails closed
(`AI_GENERATION_FAILED` / 502); a malformed failure that persists past the retry
consumes the round (the loop stays bounded). *(Revision 8: a guardrail block is
no longer part of this "no candidate content" retry path — it aborts the whole
operation at once with `AI_GENERATION_BLOCKED` / 422.)*

**Revision 7 (quality-driven configuration change, not architecture):** the
generator model is `amazon.nova-lite-v1:0`, changed from `amazon.nova-micro-v1:0`.
Production testing on Pokémon topics showed Nova Micro drafts had a high Nova Pro
rejection rate (`ANSWER_MISMATCH`, `INCORRECT_ANSWER`, `AMBIGUOUS_QUESTION`,
`FACTUAL_UNCERTAINTY`, `duplicate_text`, `correct_answer_count`). Nova Lite is a
stronger drafting model at similar cost. This is purely a value of
`BEDROCK_GENERATOR_MODEL_ID` (CDK default / context override): the pipeline,
`GameGenerator` / `GameValidator` contracts, blind validation, deterministic
comparison, repair workflow, `MAX_REPAIR_ROUNDS`, technical-retry policy, and
Guardrail configuration are all unchanged. The validator stays
`amazon.nova-pro-v1:0`. Least-privilege `bedrock:InvokeModel` now targets the
`amazon.nova-lite-v1:0` and `amazon.nova-pro-v1:0` foundation-model ARNs.

**Revision 6:** the Bedrock Guardrail evaluates only genuinely untrusted user
content on input. The Converse request wraps the user-provided **topic** in a
`guardContent` block and keeps every application-owned instruction (generation
settings, repair directives, issue codes) as plain `text`, so the Guardrail no
longer classifies our own repair prompt as a user `PROMPT_ATTACK`. Guardrail
configuration and output-side filtering are unchanged. See *Repair prompt
hygiene* below.

**Revision 5:** the generation **batch size** is authoritative and distinct from
the final game size. `GenerateGameRequest.questionCount` is how many questions
**this call** must return — `10` on the first round, `missingCount` (1..9) on a
repair round — never the fixed final size of 10. Every consumer honours it: the
generator system prompt is parameterised on the requested count (a repair prompt
says "the final game contains 10 questions, but this request is only for N
replacement questions — return exactly N"), `BedrockGameGenerator` parses the
response length against the requested count and rejects any other length as
`unexpected_question_count`, and `GenerateGameService` re-checks the batch length
as defense-in-depth before touching the candidates — an over-sized batch (e.g. a
fixed 10 for a 1-question repair) is rejected whole, never silently trimmed, and
the mismatch is logged (`validationRule = unexpected_question_count`, with the
real `generatedCount`) so it is visible in CloudWatch.

---

## Context

Real testing showed AI-generated questions that were structurally valid but
**factually miscalibrated**: the option marked `isCorrect` was not actually
correct, or more than one option was defensible, or the question was ambiguous.

The existing structural validator (`validateAndNormalizeDraft`) enforces shape,
counts, uniqueness, difficulty and category coherence, and length limits. It
cannot judge factual correctness. A single cheap model (`amazon.nova-micro-v1:0`)
both generating and self-checking is not a reliable factual gate.

Swapping to a larger generator model was rejected: it raises cost for every
request and still leaves generation self-graded.

---

## Decision

AI-generated games use a **two-model generation pipeline** inside the existing
backend Lambda and the existing `POST /games/generate` request:

```text
Amazon Nova Lite    →   draft generation             (BEDROCK_GENERATOR_MODEL_ID)
Amazon Nova Pro     →   blind independent solve      (BEDROCK_VALIDATOR_MODEL_ID)
```

### Blind independent resolution

A single earlier version asked Nova Pro to *check the marked answer*; it proved
too susceptible to rubber-stamping the generator's choice (a real bug: a
`Bulbasaur → Ivysaur → Venusaur` question marked `Venusaur` was approved).

`BedrockGameValidator` now sends Nova Pro **only** `topic`, `difficulty`,
`targetAge`, and, per question, the `question` text and the list of `answers`
as plain strings. It never sends `isCorrect`, `correctAnswerIndex`, or any
equivalent. Nova Pro independently solves every question and returns, per
question: `answerIndex` (or `null`), `confident`, `ambiguous`, and `issues`. It
also still reviews single-correct-answer, ambiguity, age, difficulty, topic,
option quality, and factual uncertainty. It never guesses and never assumes an
option must be correct. It is told to distinguish direct from indirect
relationships.

```json
{ "questions": [ { "questionIndex": 0, "answerIndex": 0, "confident": true, "ambiguous": false, "issues": [] } ], "issues": [] }
```

The reviewer output carries **no `valid` flag**. `reason` is for logging only.

### Issue severity: hard failures vs quality warnings

Real Pokémon tests showed drafts rejected almost entirely because Nova Pro
flagged easy-but-correct distractors as `INVALID_OPTIONS`, exhausting every
attempt. Issue codes are therefore split by blocking severity, decided by
Application **from the code**, never from the model's own claim:

| Severity | Codes | Effect |
|---|---|---|
| `error` (blocks) | `ANSWER_MISMATCH`, `FACTUALLY_INCORRECT`, `INCORRECT_ANSWER`, `MULTIPLE_CORRECT_ANSWERS`, `AMBIGUOUS_QUESTION`, `FACTUAL_UNCERTAINTY`, `OFF_TOPIC`, `AGE_INAPPROPRIATE`, `INVALID_OPTIONS` | invalidates the question |
| `warning` (never blocks) | `DIFFICULTY_MISMATCH`, `WEAK_DISTRACTOR`, `TOO_EASY_DISTRACTOR`, `DISTRACTOR_QUALITY` | recorded as a quality observation only |

`INVALID_OPTIONS` is now reserved for **objective** defects — duplicate options,
an empty option, the wrong option count, more than one factually correct option,
no factually correct option, or an option that makes the question malformed.
Easy / obvious / weak distractors are acceptable for a young-children "easy"
quiz and are, at most, non-blocking warnings. Structural duplicates/empties are
still caught earlier by `validateAndNormalizeDraft` regardless.

### Deterministic verdict (Application)

`GenerateGameService` computes validity. A question passes only when

```text
review.confident === true
  && review.ambiguous === false
  && review.answerIndex !== null
  && review.answerIndex === generatorAnswerIndex   // generator's own marked option
  && no ERROR-severity issue on the question
```

The draft is valid only if **every** question passes and there are no
error-severity game-level issues. A single mismatch (recorded as the
Application-only `ANSWER_MISMATCH` code) rejects the whole draft and triggers
regeneration. Warning-severity issues never reject; their count and types are
reported on `AI_GAME_VALIDATION_SUCCEEDED` (`warningCount` / `warningTypes`).

### Ports

Application depends only on two provider-neutral ports:

```ts
interface GameGenerator { generate(request: GenerateGameRequest): Promise<GeneratedGameDraft>; }

interface GameValidator { validate(request: ValidateGeneratedGameRequest): Promise<GameValidationResult>; }
```

`BedrockGameGenerator` and `BedrockGameValidator` (Bedrock Converse API) are the
only Bedrock-aware code. The two ports do not depend on each other; repair
feedback travels as neutral `previousIssues` and `existingQuestions` hints on
`GenerateGameRequest`.

### Repair prompt hygiene

The repair user message is deliberately minimal: the requested count, the
**texts of every question seen so far this operation** (Revision 9 — accepted,
rejected, or generated-then-discarded; for de-duplication only, never options or
`isCorrect`), and stable application issue codes (`ANSWER_MISMATCH`,
`AMBIGUOUS_QUESTION`, `duplicate_text`, …). It carries **no** reviewer
chain-of-thought, no free-form validator `reason` text, and no
instruction-override phrasing ("ignore the … rule", "rejected by an independent
reviewer"). `previousIssues[].reason` is a code, not LLM text, and the adapter
renders only well-formed codes.

**Revision 6 — selective Guardrail scope (`guardContent`).** Even after the
hygiene pass, the imperative shape of the application-owned repair directives
("return exactly N…", "do not repeat any of these…", the issue-code list) was
still classified by the Bedrock Guardrail's `PROMPT_ATTACK` input filter as a
user prompt attack, and every repair round for a partly-filled game was
`BLOCKED`. The Converse request now uses **selective guarding**: the single
genuinely user-controlled free-form value — the game **topic** — goes in a
`guardContent` block; every application-owned string (the `{difficulty,
questionCount}` settings, the framing line, and all repair directives) is a plain
`text` block. Per the Converse contract, once any `guardContent` block is present
the input Guardrail assesses **only** those blocks, so our own instructions are
no longer treated as user input, while the topic is still fully assessed for
prompt-attack / harmful content. **Output** assessment on the model response is
unchanged and still covers everything the model generates. `BedrockGameValidator`
applies the identical boundary: only the topic is guarded; the blind review
payload (candidate question / answer texts, already produced under the
generator's output Guardrail) and the review instructions are trusted `text`.
The Guardrail itself — content filters, denied topics, PII, word policy, output
scope, `trace: "enabled"` — is unchanged; only the *input scope* is corrected.
`shared: buildGuardedUserContent(topic, trustedInstructions)` in
`bedrockConverse.ts` is the one place this boundary is expressed.

### Pipeline — question-level repair rounds

Production testing showed whole-draft regeneration was wasteful: a single bad
question (structural *or* semantic) discarded nine good ones, and over three
attempts a request could produce far more than ten good questions yet keep none.

Retries are now **question-level repair rounds**. Valid questions are kept in an
accepted pool; only failed slots are re-requested.

```text
accepted = []                               (target: 10 unique valid questions)
repeat up to MAX_REPAIR_ROUNDS = 5:
  missing = 10 - accepted.length
  generate EXACTLY `missing` candidates      (questionCount = missing, not 10;
                       the prompt requests `missing`, the parser and the service
                       reject any other length as unexpected_question_count)
    (up to MAX_TECHNICAL_RETRIES_PER_ROUND = 1 same-round retry
                       on a no-content TECHNICAL failure: transport / malformed;
                       a guardrail block instead aborts now → AI_GENERATION_BLOCKED / 422)
    → per-question structural validation      (valid ones survive; a broken one is just that slot)
    → uniqueness vs the accepted pool         (normalized key; duplicate text → that candidate only is rejected)
    → Nova Pro blind solve of the survivors   (never sees the marked answer)
    → per-question deterministic compare      (match + confident + !ambiguous + no error issue → accept)
  accepted += newly accepted
  if accepted.length == 10 and metadata captured → assemble and persist
otherwise → AI_GENERATED_CONTENT_INVALID (HTTP 422), repository = 0
```

A guardrail block or malformed response no longer consumes a content-repair round
on its first occurrence — it gets one same-round technical retry. Question and
answer ids are reassigned by Application on final assembly, so a model reusing
ids across rounds is not a failure mode.

**Nothing is persisted before all ten questions have passed every validation.**
`GameRepository.create` is called exactly once.

### Fail closed

A **technical** failure of either model (provider unavailable, transport error,
unparseable or unexpected response, an out-of-range answer index, an incomplete
set of question results) aborts the pipeline with `AI_GENERATION_FAILED`
(HTTP 502) and never persists. It is never treated as "valid".

---

## Configuration

```text
BEDROCK_GENERATOR_MODEL_ID = amazon.nova-lite-v1:0
BEDROCK_VALIDATOR_MODEL_ID = amazon.nova-pro-v1:0
BEDROCK_REGION             = us-east-1
```

`BEDROCK_MODEL_ID` is removed in favour of the two specific variables. Existing
`AI_GAME_GENERATION_ENABLED`, `BEDROCK_GUARDRAIL_ID`, and
`BEDROCK_GUARDRAIL_VERSION` are unchanged. `AI_GAME_GENERATION_ENABLED=false`
still requires no Bedrock configuration and instantiates no Bedrock client.

The Lambda IAM role allows `bedrock:InvokeModel` on exactly the two
`foundation-model/amazon.nova-lite-v1:0` and
`foundation-model/amazon.nova-pro-v1:0` ARNs (no `bedrock:*`, no `Resource: "*"`).
The Guardrail applies to both models.

---

## Observability

Coarse, provider-neutral events (indices, counts and issue codes only — never
prompts, model output, question/answer text, or personal data):
`AI_GAME_GENERATION_ATTEMPT`, `AI_GAME_REPAIR_ROUND`,
`AI_GAME_VALIDATION_SUCCEEDED`, `AI_GAME_VALIDATION_REJECTED`,
`AI_GAME_GENERATION_EXHAUSTED`, `AI_GAME_VALIDATION_ERROR`,
`AI_GAME_GUARDRAIL_INTERVENED`.

`AI_GAME_GUARDRAIL_INTERVENED` fires when the generator returns
`guardrail_intervened` / `content_filtered`. The generator requests
`guardrailConfig.trace: "enabled"` and reads `trace.guardrail` into a
**content-free** summary: `round`, `technicalRetry`, `requestedQuestionCount`,
`guardrailId`, `guardrailVersion`, `guardrailPolicies` (e.g. `["contentPolicy"]`),
`guardrailFilterTypes` (e.g. `["PROMPT_ATTACK"]`), `guardrailActions`. The
flagged word, PII `match`, configured topic `name`, and model output are never
read. The same fields (plus `technicalRetry`) are added to the existing
`ai_generation_failure` diagnostic. *(Revision 8: a guardrail block is recorded
once and then finalizes the operation with `AI_GENERATION_BLOCKED` / 422 — it is
never retried in the same round and never lets the repair loop continue; the
event now also carries `retryable: false`.)* Since Revision 6 the input Guardrail
sees only the guarded topic block, so a `PROMPT_ATTACK` here now means the
**topic itself** was flagged, not our repair prompt — `AI_GAME_GUARDRAIL_INTERVENED`
with `guardrailFilterTypes: ["PROMPT_ATTACK"]` on repair rounds should no longer
occur for well-formed topics. The event/observability shape is unchanged.

Repair context: `AI_GAME_GENERATION_ATTEMPT` carries `round`, `technicalRetry`
(0 for the first attempt, 1.. for a same-round retry), `requestedQuestionCount`,
`acceptedQuestionCount`. `AI_GAME_REPAIR_ROUND` separates the per-round counts:
`generatedCount`, `acceptedCount`, `rejectedQuestionCount` (QUESTIONS, not
issues), `issueCount` (≥ `rejectedQuestionCount`, since one rejected question can
carry several issues), `missingCount`. `AI_GAME_VALIDATION_SUCCEEDED` shows
`acceptedQuestionCount = 10` (plus `warningCount` / `warningTypes`).

When a round's generation returns a batch whose size ≠ `requestedQuestionCount`
(e.g. a fixed 10 for a 1-question repair), the whole batch is rejected: an
`ai_generation_failure` diagnostic with `failureType = validation_failed` /
`validationRule = unexpected_question_count` is logged, an
`AI_GAME_VALIDATION_REJECTED` event carries `issueTypes: ["unexpected_question_count"]`,
and `AI_GAME_REPAIR_ROUND` reports the real `generatedCount` alongside the smaller
`requestedQuestionCount` so the over-generation is visible in CloudWatch rather
than hidden by a silent trim.

`AI_GAME_VALIDATION_REJECTED` is emitted once per failing slot and carries
`round`, `questionIndex` (slot), `issueTypes` (e.g. `["ANSWER_MISMATCH"]` or a
structural rule such as `"duplicate_text"`), and, for a semantic rejection,
`generatorAnswerIndex`, `validatorAnswerIndex`, `confident`, `ambiguous` — so a
wrong-key rejection is diagnosable from logs.

---

## Consequences

- **Cost / success rate**: content-repair rounds are bounded by
  `MAX_REPAIR_ROUNDS = 5` and each round by `MAX_TECHNICAL_RETRIES_PER_ROUND = 1`
  — worst case ~10 generator + 5 Nova Pro calls, though repair rounds ask for
  only the missing questions (small calls). *(Revision 8: a guardrail block short-
  circuits this fan-out entirely — one blocked call, then `AI_GENERATION_BLOCKED`
  / 422 — so a policy-blocked topic can no longer push the Lambda to its
  timeout.)*
- **Latency**: two sequential Bedrock calls per round; repair rounds send far
  fewer questions. The existing 28 s Lambda timeout is unchanged; worst-case
  repair fan-out may not fit in it, which is acceptable for a throttled,
  user-triggered route that fails closed.
- No Step Functions, SQS, EventBridge, extra Lambda, async workflow, or new
  DynamoDB table. Runs inside the current backend Lambda.
- Frontend, HTTP contracts, DynamoDB schema, `GameRepository`, `Game`,
  `GameSession`, and non-generation routes are unchanged.
- The reviewing model is replaceable behind `GameValidator`; tests use fakes.
