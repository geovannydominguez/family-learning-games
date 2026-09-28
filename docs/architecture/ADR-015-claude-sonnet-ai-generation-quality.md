# ADR-015 --- Claude Sonnet 4.6 for AI generation quality

## Status

Accepted for v0.7.1.

## Context

The AI generation pipeline established by ADR-011 uses separate
Generator and Validator invocations followed by deterministic
Application validation.

The v0.7 baseline configured Amazon Nova Lite as Generator and Amazon
Nova Pro as Validator.

Practical testing identified quality limitations, including factual
errors, generic questions for specific topics, insufficient
differentiation between difficulty levels, and repeated/basic questions.

A controlled runtime experiment replaced both configured models with
Claude Sonnet 4.6 without changing the application architecture. Testing
showed improved clarity, variety, and overall question quality.

It also identified operational considerations:

-   easy/normal/hard differentiation still depends strongly on prompt
    semantics;
-   correct answers appear to be emitted by the Generator in the first
    position and the end-to-end presentation path must be verified;
-   Claude Sonnet 4.6 has higher latency than the previous Nova
    configuration;
-   repair rounds may exceed the existing synchronous Lambda/API
    execution budget;
-   current AI telemetry does not contain enough non-sensitive context
    to diagnose every failed generation.

An investigation into repeated `OFF_TOPIC` rejections tested whether
Claude could consume a topic provided through Bedrock `guardContent`.

Controlled testing demonstrated that Claude Sonnet 4.6 can consume that
topic and that the production Validator accepts clearly relevant
questions.

Therefore the guarded-topic mechanism is not changed by this ADR.

## Decision

For v0.7.1:

1.  Configure Claude Sonnet 4.6 as the Bedrock Generator model.
2.  Configure Claude Sonnet 4.6 as the Bedrock Validator model.
3.  Preserve separate Generator and Validator invocations.
4.  Preserve deterministic Application-side comparison and rejection.
5.  Preserve the existing Bedrock Guardrail and guarded-topic mechanism.
6.  Strengthen Generator instructions for explicit easy/normal/hard
    semantics, age-appropriate difficulty, intra-game question
    diversity, and plausible distractors, especially for normal and
    hard.
7.  Treat `targetAge` and `difficulty` as independent dimensions.
8.  Verify the complete answer-ordering path. If generator ordering
    reaches the player unchanged, randomize answer choices outside the
    model while preserving correctness mapping.
9.  Improve server-side AI observability using non-sensitive diagnostic
    metadata rather than logging raw player identity or unnecessary
    prompt content.
10. Account for the synchronous execution budget before beginning
    additional repair/retry work, returning a controlled failure when
    safe completion is no longer feasible.
11. Represent the Claude model configuration in repository/CDK
    configuration so deployments are reproducible.

## Model configuration

The expected v0.7.1 configuration is:

``` text
BEDROCK_GENERATOR_MODEL_ID=global.anthropic.claude-sonnet-4-6
BEDROCK_VALIDATOR_MODEL_ID=global.anthropic.claude-sonnet-4-6
BEDROCK_REGION=us-east-1
```

These values remain configuration. They must not become Domain or
Application constants.

## Why the same model for Generator and Validator?

v0.7.1 intentionally keeps the experiment simple and controlled.

Using the same model for both roles allows the project to evaluate the
quality impact of the model migration without simultaneously redesigning
the validation architecture.

The calls remain independent and stateless.

Using the same model does not make its output trusted; deterministic
Application validation remains mandatory.

This decision does not prevent a future version from selecting different
models for Generator and Validator.

## Difficulty

Difficulty is not defined by vocabulary complexity alone.

For a fixed target age:

``` text
easy   → basic/direct knowledge
normal → more specific knowledge + plausible alternatives
hard   → detailed/less obvious knowledge + strong distractors
```

Increasing difficulty must not violate age appropriateness.

## Diversity

v0.7.1 addresses diversity within one generated game.

It does not introduce persistent memory of questions from previous
games.

Avoiding semantic repetition across independent generations would
require additional context, persistence, or similarity mechanisms and is
outside this patch.

## Answer ordering

The model is not responsible for security or fairness of answer
position.

If generated correct answers consistently occupy one position,
deterministic application behavior must prevent that ordering from
becoming a player-visible pattern.

The existing presentation path must be inspected before implementing a
new shuffle to avoid double-shuffling or unnecessary changes.

## Latency and repair

Claude Sonnet 4.6 has shown materially higher latency than the previous
Nova configuration.

Increasing Lambda timeout alone is not considered the primary solution,
because the request remains synchronous and upstream integration
timeouts also apply.

The application should avoid starting additional expensive work when the
remaining execution budget cannot safely accommodate it.

A future architecture may adopt asynchronous generation if product
requirements justify it; v0.7.1 does not.

### Execution-budget policy (v0.7.1)

A controlled live measurement (15 generator + 15 validator calls; Claude
Sonnet 4.6, `us-east-1`, the project Guardrail; topic "Mundiales de
Fútbol", `normal`, `targetAge` 8; batch sizes 1, 2, 3, 5, 10; 3 runs
each) showed latency is **fixed + variable per question**: generator
≈ 2.8 s + 1.05 s/question, validator ≈ 1.9 s + 0.33 s/question with more
variance. Observed maxima: 1 → 4.08 s / 2.97 s, 2 → 5.22 s / 2.24 s,
3 → 6.36 s / 3.59 s, 5 → 8.70 s / 5.22 s, 10 → 13.32 s / 6.03 s. No AWS SDK
internal retry occurred (`attempts = 1` on every call).

The budget is therefore estimated per **batch size** `n` (the questions
requested by that call, not the final game size), with envelopes above
every observed maximum:

``` text
estimatedGeneratorMs(n) = 3000 + 1200 × n
estimatedValidatorMs(n) = 3000 +  450 × n
safetyMarginMs          = 1000

start a generation  if remaining ≥ gen(n) × genFactor + val(n) × valFactor + margin
start a validation  if remaining ≥ val(n) × valFactor + margin
factor (per role)   = max(1, observedMs / estimatedMs(observed batch size)),
                      never decreasing within one request
```

The margin covers the work after the last AI call (deterministic
comparison, answer shuffle, DynamoDB PutItem, serialization, logs) and
residual variance; the envelopes already absorb the measured variance.
When a call does not fit, the request ends with an existing public error:
`422 AI_GENERATED_CONTENT_INVALID`, or `502 AI_GENERATION_FAILED` when the
call that cannot be afforded is the technical retry of a provider fault.
`AI_GAME_EXECUTION_BUDGET_EXHAUSTED` records the operation (`generate`,
`repair`, `technical_retry`, `validate`), batch size, remaining and
required time.

These values are experimental evidence from one controlled measurement,
not a Bedrock latency guarantee or SLA. They are centralized in
`src/application/game/executionBudget.ts` and should be revisited if
production telemetry (`generatorDurationMs` / `validatorDurationMs`)
diverges.

`MAX_REPAIR_ROUNDS = 5` (ADR-011) is unchanged and remains the **upper
bound** on rounds and cost; it is not a guarantee that five rounds run.
The execution budget is the effective operational limit: with the 28 s
Lambda timeout, a typical 10-question first round (~18–19 s) leaves room
for a small repair (1 question, sometimes 2), not for larger ones.

## Observability

Diagnostic telemetry should make generation failures traceable without
violating player-data minimization.

Prefer metadata such as:

``` text
correlationId
attempt
round
difficulty
targetAge
topicHash
issueTypes
bounded validator reason
generatorDurationMs
validatorDurationMs
```

Do not log player identity merely to diagnose AI generation.

## Consequences

### Positive

-   higher observed generation quality;
-   no new architectural layer;
-   no new AWS resource;
-   existing ports remain unchanged;
-   Guardrails remain unchanged;
-   deployment becomes reproducible;
-   better distinction between game difficulty levels;
-   improved diagnostic capability.

### Negative

-   Sonnet 4.6 has greater latency than the previous Nova configuration;
-   using Sonnet for both Generator and Validator increases inference
    cost;
-   same-model validation does not provide model-family independence;
-   synchronous repair capacity is more constrained;
-   prompt quality remains important even with a stronger model.

## Alternatives considered

### Keep Nova Lite + Nova Pro

Rejected for v0.7.1 because practical testing showed lower question
quality than the Claude Sonnet 4.6 experiment.

### Claude Generator + Nova Validator

Not selected for this patch because it changes two experimental
dimensions: generator quality and cross-model validation behavior. It
remains a possible future optimization for latency/cost.

### Different Claude models for Generator and Validator

Deferred. v0.7.1 first establishes a controlled Sonnet 4.6 baseline.

### Add RAG / Knowledge Base / web grounding

Rejected for v0.7.1. The current problem does not justify the additional
infrastructure, persistence, cost, and complexity.

### Persist generated-question history

Rejected for v0.7.1. Cross-game semantic deduplication is not required
by this patch.

## Relationship with previous ADRs

ADR-015 does not replace ADR-014.

ADR-014 continues to define the v0.7 online-first PWA architecture.

ADR-015 refines the AI implementation governed primarily by ADR-011
while preserving its two-invocation and deterministic-validation
principles.

ADR-012 and ADR-013 remain authoritative for player persistence and
age-aware personalization.

## Out of scope

-   RAG;
-   Knowledge Bases;
-   web grounding;
-   embeddings;
-   vector databases;
-   persistent cross-game semantic deduplication;
-   asynchronous generation architecture;
-   authentication;
-   multimedia;
-   multiplayer;
-   new game types.
