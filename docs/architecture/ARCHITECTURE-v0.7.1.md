# Family Learning Games --- Architecture v0.7.1

## 1. Purpose

v0.7.1 is a quality and operational hardening patch for the AI game
generation pipeline introduced in previous versions.

It does not introduce a new product phase or a new architectural layer.

The goals are:

-   replace the Nova-based generation/validation configuration with
    Claude Sonnet 4.6 through Amazon Bedrock;
-   improve differentiation between easy, normal, and hard questions;
-   improve question and distractor quality;
-   preserve deterministic validation before persistence;
-   improve diagnostic observability of failed AI generations;
-   verify that answer ordering does not reveal the correct answer;
-   make the AI configuration reproducible through
    infrastructure/configuration instead of relying on manual Lambda
    changes.

The v0.7 PWA architecture remains unchanged.

## 2. Baseline

v0.7.1 builds directly on v0.7.

The following accepted decisions remain in force:

-   ADR-009 --- AI-generated game validation and identity.
-   ADR-010 --- AWS Amplify Hosting.
-   ADR-011 --- two-model AI generation pipeline.
-   ADR-012 --- persistent player profiles.
-   ADR-013 --- age-aware AI personalization.
-   ADR-014 --- online-first PWA.
-   ADR-015 --- Claude Sonnet 4.6 AI generation quality evolution.

No previous ADR is superseded unless ADR-015 explicitly refines an
implementation detail.

## 3. Architecture

``` text
GitHub
   ↓
AWS Amplify Hosting
   ↓
Browser / Installed PWA
   ↓
Next.js
   ↓
GameApiClient
   ↓
API Gateway HTTP API
   ↓
family-learning-games-backend Lambda
   ↓
Application
   │
   ├── GenerateGameService
   │      │
   │      ├── GameGenerator
   │      │      ↓
   │      │   BedrockGameGenerator
   │      │      ↓
   │      │   Claude Sonnet 4.6
   │      │
   │      ├── GameValidator
   │      │      ↓
   │      │   BedrockGameValidator
   │      │      ↓
   │      │   Claude Sonnet 4.6
   │      │
   │      └── deterministic review / repair
   │
   └── repositories
          ↓
       DynamoDB
```

There is still one backend Lambda, one HTTP API, one Game domain, and
one AI generation pipeline. v0.7.1 adds no RAG, Knowledge Base, vector
database, agent, second Lambda, or second API.

## 4. AI model configuration

The v0.7.1 deployment configuration uses:

``` text
BEDROCK_GENERATOR_MODEL_ID=global.anthropic.claude-sonnet-4-6
BEDROCK_VALIDATOR_MODEL_ID=global.anthropic.claude-sonnet-4-6
BEDROCK_REGION=us-east-1
```

The model IDs remain external configuration. Domain and Application must
not depend on Anthropic or Amazon Bedrock model-specific types.

The existing `GameGenerator` and `GameValidator` ports remain unchanged.

## 5. Generation and validation

Generation remains a two-invocation pipeline:

``` text
Generation request
      ↓
Resolve player → derive targetAge
      ↓
GameGenerator → Claude Sonnet 4.6
      ↓
Generated draft
      ↓
structural normalization / deduplication
      ↓
GameValidator → Claude Sonnet 4.6
      ↓
Independent review
      ↓
Deterministic Application comparison
      ├── accepted questions
      └── rejected questions → repair round
```

The validator does not receive the generator's declared correct answer
as authoritative input when independently solving a question.
Application remains responsible for the final deterministic decision. AI
output remains untrusted until validated.

## 6. Difficulty semantics

`difficulty` and `targetAge` remain independent dimensions.

`targetAge` controls age appropriateness: vocabulary, sentence
complexity, expected developmental knowledge, and unsuitable or overly
advanced content.

`difficulty` controls challenge within that age-appropriate boundary.

### easy

Questions should favor basic and widely recognizable facts, direct
recall, simple concepts, and clearly distinguishable distractors.

### normal

Questions should require more specific topic knowledge, less obvious
recall, plausible distractors, and meaningful discrimination between
alternatives.

The correct answer should not normally be discoverable merely because
the other options are obviously unrelated.

### hard

Questions should favor detailed or less obvious topic knowledge;
specific events, facts, records, characters, editions, chronology,
relationships, or other topic-appropriate detail; and plausible
distractors from the same conceptual space.

Hard questions must not become inappropriate for `targetAge`. Hard does
not mean adult, university-level, obscure for its own sake, or
intentionally ambiguous.

Basic introductory questions should not satisfy hard difficulty merely
because the topic itself is complex.

## 7. Question diversity

Within one generated game, questions should not be exact or semantic
duplicates.

The generator should vary the dimensions explored within the topic when
the topic supports it, such as people or characters, events, chronology,
rules, places, records, concepts, relationships, and notable facts.

This requirement applies within a generation.

v0.7.1 does not introduce persistent cross-game semantic memory or a
vector similarity system. Separate stateless generations may still
contain conceptually similar questions.

## 8. Distractor quality

For normal and hard questions, incorrect alternatives should be
plausible.

Avoid distractors that reveal the answer merely because they belong to
an unrelated category, belong to a different
sport/franchise/era/concept, are obviously absurd, have a visibly
different grammatical form, or make the correct answer the only
semantically compatible choice.

There must still be exactly one correct answer.

## 9. Answer ordering

Generated answer ordering must not make the correct answer predictable.

The system must verify whether answer choices are shuffled after
generation.

If the current runtime path exposes generator ordering directly to
players, Application or an appropriate presentation-independent layer
must randomize answer order while preserving the correct-answer mapping.

The AI model must not be relied upon to randomize the correct-answer
position.

Any change must preserve the public API rule that correctness metadata
is not exposed to clients.

## 10. Topic handling and Guardrails

The existing guarded topic mechanism remains unchanged unless new
evidence requires otherwise.

Testing with Claude Sonnet 4.6 confirmed that the model can consume the
topic supplied through `guardContent`.

Therefore v0.7.1 does not duplicate the topic into trusted instruction
blocks merely to support Claude.

The existing Bedrock Guardrail remains enabled.

## 11. Repair rounds and execution budget

The existing repair mechanism remains conceptually unchanged: accepted
questions are retained, rejected/missing questions are regenerated, and
repair rounds do not regenerate already accepted questions
unnecessarily.

Claude Sonnet 4.6 has materially higher generation latency than the
previous Nova configuration. A normal first round has been observed
around 17--19 seconds total, while the existing Lambda timeout is
approximately 28 seconds.

v0.7.1 must avoid blindly starting additional work when insufficient
execution time remains. The exact implementation should preserve
architectural boundaries and return a controlled application error
rather than allowing Lambda to be terminated by timeout.

No timeout increase is assumed as the primary solution.

The implemented policy (batch-size-aware estimates, observed-latency
factor, 1 s safety margin, and the measurement it is based on) is
recorded in ADR-015, section *Execution-budget policy (v0.7.1)*. In
short:

``` text
estimatedGeneratorMs(n) = 3000 + 1200 × n
estimatedValidatorMs(n) = 3000 +  450 × n
safetyMarginMs          = 1000
```

`n` is the batch size of the call (for a 9/10 round, the repair is costed
as 1 question). `maxRepairRounds = 5` stays the upper bound; the
remaining execution time decides how many rounds actually run. The
values come from a controlled 30-call measurement and are not a Bedrock
SLA.

## 12. Observability

AI diagnostic events should make failed generations diagnosable without
logging unnecessary personal data.

Generation-level telemetry may include:

``` text
correlationId / generationId
attempt
round
difficulty
targetAge
topicHash
requestedQuestionCount
acceptedQuestionCount
generatorModel
validatorModel
generatorDurationMs
validatorDurationMs
```

For rejected questions, diagnostic telemetry may include:

``` text
questionIndex
issueTypes
generatorAnswerIndex
validatorAnswerIndex
confident
ambiguous
reason
```

Validator `reason` must be bounded/truncated before logging.

Do not log playerId, player name, family metadata, or full generated
questions merely for routine diagnostics. Existing correlation
identifiers should be reused where possible rather than introducing
unnecessary identity concepts.

## 13. AI data minimization

When `playerId` is supplied:

``` text
playerId
   ↓
Application
   ↓
PlayerRepository
   ↓
Player.age
   ↓
targetAge
   ↓
AI boundary
```

Bedrock receives `targetAge`. It must not receive `playerId`, player
name, `sessionId`, or family metadata.

## 14. Persistence

No new persistence technology is introduced. Existing `Games`,
`GameSessions`, and `Players` DynamoDB tables remain the source of
truth.

v0.7.1 does not introduce RAG, embeddings, vector storage,
generation-history tables, persistent duplicate detection, Redis, RDS,
Aurora, or S3 as application database.

## 15. PWA

ADR-014 remains unchanged.

The application remains an installable online-first PWA. The Service
Worker continues to cache only controlled static resources and the
offline fallback.

AI requests, generated games, player data, API responses, and gameplay
state must not become PWA-cached application state.

## 16. Public API compatibility

No existing route is removed or renamed.

`POST /games/generate` keeps its existing public contract unless an
internal implementation correction can be made without changing that
contract.

Generated-answer correctness metadata must not become public.

## 17. Infrastructure impact

No new AWS resource is required.

Expected infrastructure/configuration delta:

-   configure Claude Sonnet 4.6 as generator model;
-   configure Claude Sonnet 4.6 as validator model;
-   preserve existing Bedrock Guardrail configuration;
-   preserve the existing Lambda, API Gateway, DynamoDB, Amplify
    Hosting, Route 53, and PWA architecture.

Manual model changes previously made directly in Lambda configuration
must be represented by repository/CDK configuration so the deployment is
reproducible.

## 18. Out of scope

v0.7.1 does not introduce a new product phase, authentication, RAG or
Knowledge Bases, web grounding, agents, embeddings, vector databases,
persistent cross-game duplicate detection, multimedia, offline gameplay,
multiplayer, new game types, a second Lambda, or a second API.
