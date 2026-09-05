# Family Learning Games — AGENTS.md

## Current target
> **v0.4 — AI Game Generation**

## Current roadmap phase
> **FASE 4 — Generación de juegos con IA**

## Mandatory documentation
Before modifying code, read:

1. `AGENTS.md`
2. `docs/architecture/ARCHITECTURE-v0.4.md`
3. `docs/architecture/ADR-008-amazon-bedrock-game-generator.md`
4. `docs/architecture/ADR-009-ai-game-validation-and-identity.md`
5. `docs/architecture/REQUIREMENTS-v0.4.md`

Previous accepted architecture/ADRs remain relevant unless superseded.

## Architecture

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
   ├── GameGenerator ──► BedrockGameGenerator ──► Amazon Bedrock
   └── Repository ports ──► DynamoDB repositories ──► DynamoDB
   ↓
Domain
```

## Mandatory rules

### Domain is AWS-independent
No AWS SDK, Bedrock, Lambda, API Gateway, DynamoDB, or CDK imports in Domain.

### Application is provider-independent
Application depends on `GameGenerator`, never directly on Bedrock SDK types.

### AI is Infrastructure
Bedrock request construction, provider prompts, model configuration, and response parsing belong in Infrastructure.

### Never trust model output
AI-produced data is untrusted. Validate deeply before persistence.

### One game domain
Seeded and generated games use the same `Game` and `GameSession`.

## Identity rule
`gameId = categoryId` is no longer a domain invariant.

Existing seeded IDs remain valid. Generated games use unique IDs created by Application through an injected ID factory. Persistence must use a conditional create and translate collisions without overwriting an existing game.

`POST /game-sessions` accepts an optional `gameId`. When present, `gameId` selects the game and its category must match `categoryId`; when absent, lookup falls back to `categoryId` exactly as in v0.3. Generated-game UI flows must send `gameId`. This is an additive, backward-compatible request change.

## Generation rules
Generation must:
- happen only on explicit request
- accept a topic of at most 80 characters
- use supported difficulty
- require exactly 10 questions
- produce exactly 4 answers per question
- limit titles to 100 characters, questions to 240 characters, and answers to 120 characters
- be family/child appropriate
- produce exactly one correct answer per question
- pass structural and domain validation
- use bounded retries only
- return public DTOs without correct answers

Do not send family names, profiles, secrets, or unrelated personal data to the model.

## Configuration
Do not hardcode models in Domain/Application.

Use configuration such as:

```text
AI_GAME_GENERATION_ENABLED
BEDROCK_MODEL_ID
BEDROCK_REGION
BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
```

AI generation defaults to disabled. Bedrock model, region, and Guardrail configuration are required only when it is enabled. CDK provisions the basic configurable Guardrail and passes only its ID/version to Infrastructure; Domain and Application remain unaware of it.

## Persistence
Use the existing `Games` table. Do not create a separate AI games table.

Persist only accepted games.

Do not persist raw model reasoning or unnecessary raw provider responses.

## Allowed in v0.4
- Amazon Bedrock SDK in Infrastructure
- `GameGenerator`
- `BedrockGameGenerator`
- generation use case
- strict parsing/validation
- unique generated IDs
- `POST /games/generate`
- minimal frontend flow for explicit generation
- Bedrock IAM/config
- tests/fakes/mocks
- bounded retry

## Out of scope
Do not add:
- Cognito/auth
- family/child profiles
- stored personalization
- RAG/embeddings/vector DB
- chat
- image/audio generation
- SQS/SNS/EventBridge/Step Functions
- WebSockets/multiplayer
- leaderboards/recommendations
- RDS/Redis/AppSync
- admin UI
- model fine-tuning
- production-scale redesign

## API compatibility
Do not remove or rename:

```text
GET  /game-setup
GET  /games
GET  /games/{gameId}
POST /game-sessions
GET  /game-sessions/{sessionId}
POST /game-sessions/{sessionId}/answers
```

Add:

```text
POST /games/generate
```

The session request may add optional `gameId` without removing or changing the existing fields.

`answers[].isCorrect` must never be public.

## Error handling
Map provider failures to application errors such as:

```text
INVALID_GENERATION_REQUEST
AI_GENERATION_DISABLED
AI_GENERATION_FAILED
AI_GENERATED_CONTENT_INVALID
```

Never expose Bedrock exception names, raw responses, prompt internals, AWS request IDs, or stack traces.
Guardrail interventions map to a safe application error. API Gateway throttling returns HTTP `429`; the frontend must show a retry-later state and must not retry aggressively.

## Content validation
At minimum:
- title/category
- exactly 10 questions
- supported difficulty
- non-empty question/answer text
- exactly 4 answers per question
- exactly one correct answer
- unique question IDs
- unique answer IDs per question
- consistent category
- title <= 100, question <= 240, and answer <= 120 characters

Do not rely on shallow `Array.isArray()` checks for model output.

## Cost and latency
Generation is synchronous in v0.4.

No generation on page load.
No automatic background generation.
No unbounded retries.
Limit model output to 4096 tokens and the Lambda execution budget to 28 seconds.

Throttle only `POST /games/generate`, defaulting to 1 request/second with burst 2. Keep both limits configurable in CDK; do not apply them to existing gameplay routes.

Only propose async architecture after real latency evidence.

## IAM
Grant least privilege for Bedrock model invocation and Guardrail application, and preserve DynamoDB least privilege.

## Testing
Normal tests must not require live Bedrock.

Use fake/mock `GameGenerator`.

Test Application, provider mapping/parsing, invalid output, HTTP behavior, public DTO protection, persistence, and CDK IAM/config.

## Workflow for coding agents

1. Read docs.
2. Inspect current v0.3 code.
3. Preserve boundaries.
4. Add `GameGenerator`.
5. Add generation use case.
6. Add deterministic validation.
7. Add Bedrock adapter.
8. Persist accepted game.
9. Add API route.
10. Add minimal frontend flow if required.
11. Add CDK IAM/config.
12. Add tests.
13. Run the standard project validations defined below.
14. Summarize changed files, AWS delta, test results, and manual deployment steps.

Do not stop because the total change exceeds an arbitrary line limit. If a patch limit exists, use multiple coherent edits on the same branch.

Do not create branch chains unless explicitly requested.

Do not run Gentle AI, 4R, Judgment Day, or any Gentle AI-dependent review as part of the normal workflow unless the user explicitly requests that specific review for the current task.

## Gentle AI policy

`gentle-ai` is optional for this project and is **opt-in only**.

Do **not** execute any `gentle-ai` command unless the user explicitly requests Gentle AI in the current task.

This includes, but is not limited to:

- `gentle-ai review`
- `gentle-ai review finalize`
- 4R reviews
- Judgment Day / dual adversarial review
- automated Gentle AI reviewers
- Gentle AI PR workflows
- Gentle AI issue workflows
- `gentle-ai skill-registry refresh`
- any subagent, skill, hook, or workflow whose execution invokes `gentle-ai`

The presence of any of the following does **not** constitute authorization to execute Gentle AI:

- `.atl/skill-registry.md`
- Gentle AI skills under `~/.config/opencode/skills`
- Gentle AI skills under `~/.codex/skills`
- a `gentle-ai` binary installed in the environment
- previously generated Gentle AI review state or receipts
- a previous `escalated`, `inconclusive`, or failed Gentle AI review

Default project validation is the standard validation section below.

Gentle AI may be used only when the user explicitly says something equivalent to:

- "run gentle-ai"
- "run the 4R review"
- "use judgment-day"
- "perform a Gentle AI review"

Do **not** infer Gentle AI authorization from generic instructions such as:

- review
- validate
- check
- verify
- inspect
- test
- audit

unless Gentle AI or a specific Gentle AI workflow is explicitly named.

A Gentle AI failure, escalation, receipt, or previous review state must **not** block normal project work, validation, commit preparation, or completion reporting unless the user explicitly required Gentle AI as a gate for the current task.

Do not edit, override, fabricate, or manually approve Gentle AI receipts or review state.

## Skill selection policy

Skills may be discovered and read when relevant, but a skill must not be loaded or executed if its required workflow invokes `gentle-ai`, unless the user explicitly authorized Gentle AI for the current task.

If a matching skill depends on Gentle AI and Gentle AI was not explicitly authorized:

- skip that skill;
- continue using the project instructions in `AGENTS.md` and the mandatory architecture documentation;
- report `skill_resolution: skipped_gentle_ai` when skill resolution is part of the agent's output;
- do not treat the skipped skill as a blocker;
- do not replace it with another Gentle AI workflow.

The skill registry is an index only. Its existence does not override this policy.

## Validation

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

## Definition of Done
v0.4 is complete when:
- explicit API request generates a game
- Application uses provider-neutral `GameGenerator`
- Bedrock exists only in Infrastructure
- generated output is deeply validated
- invalid output is never persisted
- generated game IDs are independent from category IDs
- seeded games still work
- generated games persist in `Games`
- correct answers remain private
- generated games work with the current session flow
- IAM/config are defined in CDK
- local tests do not require live AI
- validation commands pass
- no later-phase features are introduced

> **AI generates candidates; the application decides what becomes a game.**
