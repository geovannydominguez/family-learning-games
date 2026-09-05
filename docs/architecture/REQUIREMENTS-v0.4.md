# REQUIREMENTS-v0.4.md

# Family Learning Games — Requirements v0.4

## Objective
Implement FASE 4 — Generación de juegos con IA.

The backend must generate a family-friendly game using Amazon Bedrock, validate it, persist it in the existing `Games` table, and make it playable through the existing session flow.

## Mandatory references
Read and follow:

1. `AGENTS.md`
2. `docs/architecture/ARCHITECTURE-v0.4.md`
3. `docs/architecture/ADR-008-amazon-bedrock-game-generator.md`
4. `docs/architecture/ADR-009-ai-game-validation-and-identity.md`

Previous accepted ADRs remain applicable unless superseded.

## Functional requirements

### FR-001 — Endpoint
Add:

```text
POST /games/generate
```

Request:

```json
{
  "topic": "dinosaurs",
  "difficulty": "easy",
  "questionCount": 10,
  "playerId": "amelia"
}
```

### FR-002 — Input validation
Validate topic, supported difficulty, and question count before invoking AI:

- topic is non-empty and at most 80 characters;
- `questionCount` is exactly `10` in v0.4.

### FR-003 — Provider abstraction
Application calls a `GameGenerator` interface. Runtime implementation uses Amazon Bedrock.

### FR-004 — Generated candidate
The candidate must contain enough information to construct the existing `Game` domain model, including server-side correct-answer information.

### FR-005 — Output validation
Validate:
- exactly 10 questions
- supported difficulty
- non-empty content
- title length at most 100 characters
- question text length at most 240 characters
- answer text length at most 120 characters
- category ID/name/description/icon lengths at most 80/100/300/16 characters
- question and answer ID lengths at most 80 characters
- optional emoji/image lengths at most 16/2048 characters; supplied optional values must trim to non-empty text
- exactly 4 answers per question
- exactly one correct answer
- unique IDs
- category consistency

### FR-006 — Bounded retry
At most one regeneration after malformed, invalid, or Guardrail-intervened model output. Provider failures must not cause unbounded retries.

### FR-007 — Unique gameId
Generated games use IDs independent from category IDs. The Application creates the trusted ID through an injected ID factory after validating the generated draft. Provider output does not define durable identity. Existing seeded IDs remain valid.

### FR-008 — Persistence
Persist valid generated games in the existing `Games` table using a conditional create. An ID collision must not overwrite an existing game and must map to an application-level conflict.

### FR-009 — Public DTO
Never expose `answers[].isCorrect`, raw provider output, prompt internals, or AWS metadata.

### FR-010 — Compatibility
Existing v0.3 routes remain compatible. `POST /game-sessions` accepts an optional `gameId`: when present it selects that exact game, takes precedence over category lookup, and must be coherent with the supplied `categoryId`; when absent, the existing v0.3 `categoryId` behavior remains unchanged. The generated-game UI sends the returned `gameId` when starting a session. Generated games also work with `GET /games/{gameId}`.

### FR-011 — Feature flag
Support `AI_GAME_GENERATION_ENABLED`, disabled by default. When disabled, no Bedrock invocation occurs. Bedrock model and Guardrail configuration is required only when generation is enabled.

### FR-012 — Bedrock Guardrail
CDK provisions a basic configurable Amazon Bedrock Guardrail and exposes its identifier and version to the runtime as `BEDROCK_GUARDRAIL_ID` and `BEDROCK_GUARDRAIL_VERSION`. The adapter applies it during generation and maps interventions to safe application/API errors. Domain and Application remain unaware of Bedrock and Guardrail types.

### FR-013 — Generation throttling
Throttle only `POST /games/generate`, with configurable defaults of 1 request per second and burst 2. Keep API Gateway HTTP API. A throttled request returns `429`, and the frontend must not retry it aggressively.

### Age-appropriate AI generation

- Every player used for AI generation must have an age.
- AI-generated questions must be appropriate for the selected player's age.
- Generation difficulty (`easy`, `normal`, `hard`) must be interpreted relative to that age.
- The AI provider must receive the target age but must not receive the player's name or avatar.
- For young children, generated content must avoid clearly advanced concepts outside the expected age range.
- v0.4 does not introduce configurable family profiles; richer profile information remains deferred to FASE 6.

## Non-functional requirements

- Domain contains no AWS/Bedrock imports.
- Application depends on `GameGenerator`, not Bedrock SDK.
- No credentials/model secrets reach the client.
- IAM must use least privilege.
- Generation occurs only on explicit user action.
- Automated tests must not require live Bedrock.
- Provider errors map to application/API errors.
- Backward compatibility with v0.3 is preserved.
- Bedrock model output is limited to 4096 tokens.
- The generation Lambda timeout budget is 28 seconds.

## Suggested contracts

```ts
interface GenerateGameRequest {
  topic: string;
  difficulty: Difficulty;
  questionCount: number;
  targetAge: number;
}

interface GenerateGameCommand {
  topic: string;
  difficulty: Difficulty;
  questionCount: number;
  playerId: string;
}

interface GeneratedGameDraft {
  title: string;
  category: Category;
  questions: Question[];
}

interface GameGenerator {
  generate(request: GenerateGameRequest): Promise<GeneratedGameDraft>;
}

interface StartGameSessionRequest {
  categoryId: string;
  difficulty: Difficulty;
  gameId?: string;
}
```

Exact naming may follow the existing codebase. When `gameId` is present in session creation, it is authoritative and the requested `categoryId` must match the selected game.

## Expected CDK changes

Add only what is necessary:

- Bedrock invoke IAM permission
- Bedrock Guardrail and least-privilege permission to apply it
- `AI_GAME_GENERATION_ENABLED`, default `false`
- `BEDROCK_MODEL_ID`
- `BEDROCK_REGION`, derived from the stack deployment region
- `BEDROCK_GUARDRAIL_ID`
- `BEDROCK_GUARDRAIL_VERSION`
- 28-second Lambda timeout
- route-specific throttling for `POST /games/generate`, configurable with defaults of 1 request per second and burst 2

The complete stack defaults to `us-east-1`. A `deploymentRegion` override moves the whole stack; the Bedrock Runtime client, model ARN, and Guardrail must always use that same region.

Do not add a database, new API Gateway, API keys, usage plans, authentication, SQS, Step Functions, EventBridge, VPC, or Cognito.

## Implementation order

1. Read docs.
2. Inspect v0.3 code.
3. Add generation contracts/port.
4. Implement `GenerateGame` use case.
5. Implement strict generated-game validation.
6. Implement `BedrockGameGenerator`.
7. Add Application-owned generated game IDs and conditional persistence.
8. Extend session creation with optional `gameId` while preserving the category fallback.
9. Add `POST /games/generate`.
10. Preserve public DTO protections.
11. Add Bedrock Guardrail handling.
12. Add CDK IAM/config, timeout, and route-specific throttling.
13. Update the generated-game UI to start sessions with `gameId` and handle `429` without aggressive retry.
14. Add tests using fakes/mocks.
15. Run full validation.

## Required tests

Application:
- valid generation
- invalid topic/difficulty/count
- generator failure
- malformed output
- incorrect question count
- multiple/no correct answer
- duplicate IDs
- exact text-length and answer-count limits
- Application-owned ID creation
- conditional-create collision without overwrite
- persistence failure
- successful persistence
- optional session `gameId` selection, precedence, category coherence, and v0.3 fallback

HTTP:
- generation success
- invalid input
- generation disabled/failure
- throttled `429` response
- correct answers hidden
- generated-game session request includes `gameId`

Infrastructure:
- Bedrock request/response mapping
- Guardrail intervention mapping and bounded retry
- disabled mode does not require Bedrock configuration
- CDK Guardrail, IAM/config, 28-second timeout, and route-only throttle settings

## Error codes

Use consistent application errors such as:

```text
INVALID_GENERATION_REQUEST
AI_GENERATION_DISABLED
AI_GENERATION_FAILED
AI_GENERATED_CONTENT_INVALID
GAME_ID_CONFLICT
```

Do not expose Bedrock exceptions.

## Manual validation after deployment

1. verify generation is disabled by default and does not require Bedrock configuration
2. enable generation and verify Bedrock model/Guardrail configuration
3. verify Lambda IAM and 28-second timeout
4. call `POST /games/generate`
5. verify `isCorrect` is hidden
6. verify item in `Games`
7. `GET /games/{generatedGameId}`
8. play a complete session using the generated `gameId`
9. verify repeated generation requests can receive `429` without aggressive frontend retry
10. confirm no raw prompt/model response is persisted unexpectedly
11. review CloudWatch latency/errors

## Out of scope
No authentication, API keys, usage plans, profiles, RAG, embeddings, vector DB, chat, image/audio generation, multiplayer, async orchestration, admin UI, or production redesign.

## Validation commands

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

## Definition of Done

```text
explicit request
   ↓
Application
   ↓
GameGenerator
   ↓
Amazon Bedrock
   ↓
validated Game
   ↓
DynamoDB
   ↓
existing game/session flow
```

works end-to-end with no later-phase architecture introduced.

Completion also requires backward-compatible session selection, conditional game creation without overwrite, Guardrail enforcement, enabled-only Bedrock configuration, and route-only generation throttling.
