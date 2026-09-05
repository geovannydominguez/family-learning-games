# ARCHITECTURE-v0.4.md

# Family Learning Games — Architecture v0.4

## Status
**Target version:** v0.4
**Roadmap phase:** FASE 4 — Generación de juegos con IA
**Previous version:** v0.3 — Durable Persistence

## Goal
Add on-demand AI game generation while preserving the existing serverless architecture.

> Generate a valid family-friendly game, validate it, persist it in DynamoDB, and play it through the existing session flow.

## Target architecture

```text
Next.js
   ↓
GameApiClient
   ↓
API Gateway HTTP API
   ↓
AWS Lambda
   ↓
Application
   ├── GameGenerator port ──► BedrockGameGenerator ──► Amazon Bedrock
   └── Repository ports ────► DynamoDB repositories ─► DynamoDB
   ↓
Domain
```

AI is an infrastructure dependency. Domain and Application must remain independent from Bedrock SDK types.

## Generation flow

```text
POST /games/generate
   ↓
GenerateGame use case
   ↓
validate request
   ↓
GameGenerator
   ↓
Amazon Bedrock
   ↓
generated candidate
   ↓
structural validation
   ↓
domain validation
   ↓
unique gameId
   ↓
Games table
   ↓
PublicGame
```

```text
Player
  │
  └── age
       │
       ▼
GenerateGameService
       │
       └── targetAge
             │
             ▼
        GameGenerator
             │
             ▼
    BedrockGameGenerator
             │
             ▼
       Amazon Bedrock
```

Model output is never trusted directly.

## New endpoint

```text
POST /games/generate
```

Example request:

```json
{
  "topic": "dinosaurs",
  "difficulty": "easy",
  "questionCount": 10,
  "playerId": "amelia"
}
```

Generation must be triggered only by explicit user action. In v0.4, `topic` is at most 80 characters and `questionCount` must be exactly 10.

`playerId` selects the authoritative existing player in Application. Application validates
that the stored age is a positive integer and converts it to `targetAge` before invoking
`GameGenerator`; the provider receives no player ID, name, or avatar. Difficulty remains
`easy`, `normal`, or `hard` and is interpreted relative to `targetAge`. Ages 4–6 also
receive generic prompt constraints excluding advanced arithmetic and clearly
age-inappropriate concepts. This is not a configurable profile system.

## gameId vs categoryId

v0.3 used `gameId = category.id` for seeded games.

From v0.4 onward this is no longer an invariant.

```text
gameId     = unique game identity
categoryId = classification/topic identity
```

Existing seeded IDs such as `animals` remain valid. AI-generated games use unique IDs such as `ai-<unique-id>`.

No DynamoDB key migration is required because `Games` is already keyed by `gameId`.

Application creates generated `gameId` values through an injected ID factory. The repository uses a conditional create and reports a technology-neutral conflict rather than overwriting an existing item.

`POST /game-sessions` adds optional `gameId` while retaining the v0.3 request fields. When supplied, `gameId` selects the game and Application verifies that its category matches `categoryId`. Without it, lookup uses `categoryId` as before. The generated-game UI must send the returned `gameId` when starting a session.

## Persistence

Generated games are stored in the existing `Games` table.

Do not create a separate generated-games table.

Seeded and AI-generated games must use the same `Game` domain model and the same `GameSession` flow.

## Validation

Before persistence, validate at least:

- exactly 10 questions
- supported difficulty
- non-empty question text
- exactly four answers per question
- exactly one correct answer per question
- unique question IDs
- unique answer IDs per question
- consistent category IDs
- title at most 100 characters
- question text at most 240 characters
- answer text at most 120 characters
- category ID at most 80 characters, name at most 100, description at most 300, and icon at most 16
- question and answer IDs at most 80 characters
- optional emoji at most 16 characters and optional image reference at most 2048 characters

Invalid generated content must never be persisted.

One bounded retry may be attempted after invalid generation. No unbounded retries.

Each model request limits output to 4096 tokens. A Guardrail intervention is treated as rejected generated content, maps to a safe application error, and may consume the single bounded regeneration attempt.

## Public API safety

Never expose:

- `answers[].isCorrect`
- raw Bedrock responses
- prompt internals
- AWS request IDs
- model reasoning
- persistence metadata

## Child/family content requirements

Prompts must require content that is:

- family friendly
- child appropriate
- educational
- free from sexual content
- free from graphic violence
- free from hate/harassment
- free from dangerous instructions
- free from requests for private personal information

Do not send family member names or stored personal profile data to the model in v0.4.

## Bedrock Guardrail

CDK provisions a basic configurable Amazon Bedrock Guardrail for both prompt and response evaluation. Infrastructure passes `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION` on every enabled model invocation. Guardrail configuration and provider intervention details do not enter Domain/Application or public responses.

## Provider abstraction

Application depends on:

```ts
interface GameGenerator {
  generate(request: GenerateGameRequest): Promise<GeneratedGameDraft>;
}
```

`GenerateGameRequest` includes `targetAge`; the public HTTP/client command instead
includes `playerId`.

Infrastructure implements:

```text
BedrockGameGenerator implements GameGenerator
```

## Configuration

Use configuration such as:

```text
AI_GAME_GENERATION_ENABLED
BEDROCK_MODEL_ID
BEDROCK_REGION
BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
```

Do not hardcode model IDs in Domain/Application.
AI generation is disabled by default. Model and Guardrail configuration are required only when it is enabled. The whole stack defaults to `us-east-1`; an explicit deployment-region override moves the complete stack, and `BEDROCK_REGION`, the model ARN, and the Guardrail always use that same stack region. Cross-region Bedrock resources are not supported.

## Synchronous generation

v0.4 uses synchronous generation:

```text
HTTP → Lambda → Bedrock → validate → DynamoDB → HTTP
```

Do not introduce SQS, Step Functions, WebSockets, or polling unless observed latency proves this approach unworkable.

The Lambda timeout budget is 28 seconds. API Gateway throttles only `POST /games/generate`, defaulting to 1 request/second with burst 2; both values are CDK configuration. Existing gameplay routes keep their current limits. A throttled request returns HTTP `429`, and the frontend displays a retry-later state without aggressive automatic retries.

## Existing APIs

Keep:

```text
GET  /game-setup
GET  /games
GET  /games/{gameId}
POST /game-sessions
GET  /game-sessions/{sessionId}
POST /game-sessions/{sessionId}/answers
```

Add only:

```text
POST /games/generate
```

## Expected AWS delta

```text
Existing Lambda
   +
Bedrock invoke IAM permission
   +
Bedrock Guardrail and apply permission
   +
AI configuration environment variables
```

No new database, API Gateway, VPC, or Lambda is required by default.

## Out of scope

- Cognito/authentication
- family profiles
- stored personalization
- RAG/embeddings/vector DB
- chat
- image/audio generation
- multiplayer/WebSockets
- SQS/Step Functions/EventBridge workflows
- recommendations
- admin UI
- model fine-tuning
- production-scale redesign

## Definition of Done

v0.4 is complete when:

1. API can generate a game on demand.
2. Application uses a provider-neutral `GameGenerator`.
3. Bedrock exists only behind infrastructure.
4. Generated content is fully validated before persistence.
5. Generated `gameId` is created by Application, conditionally persisted, and independent from `categoryId`.
6. Existing seeded games continue to work.
7. Generated games are stored in `Games`.
8. Correct answers remain private.
9. Generated games work with the existing session flow.
10. IAM/config are managed through CDK.
11. The optional session `gameId` preserves v0.3 clients and enables generated games.
12. Guardrail enforcement, route-only throttling, default-disabled AI, and HTTP `429` handling are tested.
13. Automated tests do not require live Bedrock.
14. lint/tests/build/CDK synth succeed.

> **AI generates candidates; the application decides what becomes a game.**
