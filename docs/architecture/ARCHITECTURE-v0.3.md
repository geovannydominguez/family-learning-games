# Family Learning Games — Architecture v0.3

## 1. Status

**Version:** v0.3  
**Stage:** Phase 3 — Durable Persistence  
**Status:** Proposed architecture baseline before implementation

---

## 2. Purpose

v0.3 introduces durable persistence into the AWS backend created in v0.2.

The objective is not to expand the product with authentication, AI, profiles, multiplayer or new game modes.

The objective is:

> Make games and game sessions survive Lambda executions and backend restarts by replacing temporary/local repository implementations with DynamoDB-backed repositories while preserving the current HTTP API and domain boundaries.

---

## 3. Context

v0.2 established this architecture:

```text
Browser
   |
   v
Next.js
   |
   v
GameApiClient
   |
   v
API Gateway HTTP API
   |
   v
AWS Lambda
   |
   v
Application
   |
   v
Domain
   |
   v
Repository Contracts
   |
   v
JSON / InMemory
```

The important architectural boundary already exists:

```text
Application / Domain
        |
        v
Repository Port
        |
        v
Repository Implementation
```

v0.3 changes only the persistence implementation and the infrastructure required to support it.

---

## 4. v0.3 goals

v0.3 must:

1. Introduce Amazon DynamoDB as the durable persistence technology.
2. Persist game definitions.
3. Persist game sessions.
4. Make a created session readable from a later Lambda invocation.
5. Make submitted answers and accumulated session state durable.
6. Preserve the existing HTTP API unless a concrete persistence requirement requires a small compatible change.
7. Preserve domain independence from AWS.
8. Preserve repository contracts as the application-facing persistence boundary.
9. Provision DynamoDB tables and IAM permissions using AWS CDK with TypeScript.
10. Use least-privilege IAM permissions for Lambda.
11. Keep operational cost low for the initial family-use workload.
12. Preserve the complete playable game flow.

---

## 5. Non-goals

v0.3 does not introduce:

- AWS Cognito
- authentication
- authorization
- family accounts
- family profiles
- player history dashboards
- achievements
- leaderboards
- Amazon Bedrock
- OpenAI integration
- generative AI
- automatic game generation
- image/audio generation
- multiplayer
- WebSockets
- AppSync
- SQS
- SNS
- EventBridge
- Step Functions
- Redis / ElastiCache
- RDS / Aurora / PostgreSQL
- GraphQL
- CQRS
- Event sourcing
- formal microservices decomposition
- complex multi-environment architecture
- production-grade backup/disaster-recovery architecture

These capabilities require later roadmap phases and/or explicit ADRs.

---

## 6. Target architecture

```text
┌───────────────────────────────┐
│            Browser            │
│    Family Learning Games      │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│          Next.js UI           │
│       GameApiClient           │
└───────────────┬───────────────┘
                │ HTTPS / JSON
                ▼
┌───────────────────────────────┐
│   API Gateway HTTP API        │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│          AWS Lambda           │
│        HTTP Adapter           │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│       Application Layer       │
│ ListGames / GetGame           │
│ StartSession / SubmitAnswer   │
│ GetSession                    │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│            Domain             │
│ Game / Question / Answer      │
│ GameSession / Scoring         │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│      Repository Contracts     │
│ GameRepository                │
│ GameSessionRepository         │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│      Infrastructure Layer     │
│ DynamoDbGameRepository        │
│ DynamoDbGameSessionRepository │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│        Amazon DynamoDB        │
│ Games table                   │
│ GameSessions table            │
└───────────────────────────────┘
```

---

## 7. Architectural change from v0.2

### Before

```text
Repository Contract
        |
        +--> JsonGameRepository
        |
        +--> InMemoryGameSessionRepository
```

### v0.3

```text
Repository Contract
        |
        +--> DynamoDbGameRepository
        |
        +--> DynamoDbGameSessionRepository
```

The application layer and domain must not know that DynamoDB exists.

---

## 8. Persistence responsibilities

### GameRepository

Conceptually supports:

```ts
interface GameRepository {
  findAll(): Promise<Game[]>;
  findById(id: string): Promise<Game | null>;
}
```

For v0.3, game creation/editing APIs are not required unless already needed by the current application.

Initial game records may be seeded as part of a controlled development process.

### GameSessionRepository

Conceptually supports the minimum operations required by the current use cases:

```ts
interface GameSessionRepository {
  create(session: GameSession): Promise<void>;
  findById(sessionId: string): Promise<GameSession | null>;
  save(session: GameSession): Promise<void>;
}
```

Exact signatures should follow the current codebase and domain model rather than forcing this example literally.

---

## 9. DynamoDB data model

Use two tables for v0.3.

### 9.1 Games table

Purpose:

> Store playable game definitions.

Recommended primary key:

```text
PK: gameId
```

Conceptual item:

```json
{
  "gameId": "animals-easy-001",
  "title": "Animals",
  "category": "animals",
  "difficulty": "easy",
  "questions": [
    {
      "questionId": "q1",
      "prompt": "Which animal says meow?",
      "options": [
        { "optionId": "a", "text": "Dog" },
        { "optionId": "b", "text": "Cat" },
        { "optionId": "c", "text": "Cow" },
        { "optionId": "d", "text": "Duck" }
      ],
      "correctOptionId": "b"
    }
  ],
  "version": 1,
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z"
}
```

For the current small games, storing the complete game definition as one DynamoDB item is acceptable and intentionally simple.

Do not normalize questions into separate tables unless a concrete access pattern requires it.

### 9.2 GameSessions table

Purpose:

> Store the durable state of a play session.

Recommended primary key:

```text
PK: sessionId
```

Conceptual item:

```json
{
  "sessionId": "uuid",
  "gameId": "animals-easy-001",
  "status": "IN_PROGRESS",
  "currentQuestionIndex": 2,
  "score": 1,
  "answers": [
    {
      "questionId": "q1",
      "selectedOptionId": "b",
      "correct": true,
      "answeredAt": "2026-09-01T00:00:00.000Z"
    }
  ],
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:01:00.000Z",
  "completedAt": null
}
```

No secondary index is required for v0.3 unless an implemented access pattern needs one.

---

## 10. Access patterns

v0.3 should optimize only for current product operations.

### Games

```text
List all available games
Get one game by gameId
```

### Sessions

```text
Create session
Get session by sessionId
Persist answer/progress
Persist completed state
```

Not required yet:

```text
List sessions by player
List sessions by family
Rank players
Search by date
Analytics queries
Global leaderboard
```

Those access patterns should not distort the v0.3 table design.

---

## 11. Consistency and concurrency

The backend must not rely on a read-modify-write sequence without protection when submitting answers.

For session updates, prefer a conditional write that verifies the expected current session state.

Example invariant:

```text
Expected currentQuestionIndex == submitted question index
```

A stale or duplicate answer must not silently advance the session twice.

The repository may use DynamoDB conditional expressions internally.

The domain/application layer should receive a technology-neutral conflict/error result.

---

## 12. API behavior

The existing candidate API remains appropriate:

```text
GET  /games
GET  /games/{gameId}
POST /game-sessions
POST /game-sessions/{sessionId}/answers
GET  /game-sessions/{sessionId}
```

Persistence must not cause the frontend to import AWS SDKs or communicate directly with DynamoDB.

Correct direction remains:

```text
Next.js
   |
   v
HTTP API
   |
   v
Backend
   |
   v
Repository
   |
   v
DynamoDB
```

Never:

```text
Browser
   |
   v
DynamoDB
```

---

## 13. Infrastructure

Extend the existing CDK backend stack.

Conceptual result:

```text
FamilyLearningGamesBackendStack
        |
        +-- API Gateway HTTP API
        +-- Lambda
        +-- CloudWatch Logs
        +-- Games DynamoDB table
        +-- GameSessions DynamoDB table
        +-- Lambda IAM permissions
```

CDK remains the infrastructure source of truth.

---

## 14. DynamoDB capacity mode

Use on-demand capacity for v0.3.

Rationale:

- traffic is currently very small and irregular
- no capacity planning is needed
- no provisioned throughput should remain running unnecessarily
- it keeps the initial operational model simple

Do not introduce auto-scaling configuration for provisioned capacity in v0.3.

---

## 15. Resource lifecycle and cost posture

The initial environment is development-oriented.

For the v0.3 `dev` stack:

- use on-demand DynamoDB capacity
- avoid optional paid infrastructure that is not required
- tables may use a destroy-oriented removal policy for disposable development environments
- do not enable expensive optional features without a requirement
- verify the generated CloudFormation with `cdk synth`
- destroying the CDK stack should remove the v0.3 disposable tables when configured for development

Important:

> A destroy-oriented table policy is appropriate only while the persisted data is disposable development data.

Before treating stored family/user progress as valuable production data, lifecycle and backup decisions must be revisited.

---

## 16. IAM

Lambda receives only the DynamoDB permissions required by its repositories.

Expected operations may include:

```text
GetItem
PutItem
UpdateItem
Scan
```

`Scan` is acceptable for the very small `GET /games` catalog in v0.3.

Do not grant broad permissions such as:

```text
dynamodb:*
```

Do not grant access to unrelated tables.

---

## 17. Configuration

Table names must be injected into the Lambda through environment configuration created by CDK.

Example:

```text
GAMES_TABLE_NAME
GAME_SESSIONS_TABLE_NAME
```

Application/domain code must not read these variables directly.

AWS/environment configuration belongs to infrastructure composition.

---

## 18. Seed data

The initial game catalog must be persisted into DynamoDB so the application remains playable after removing the JSON-backed runtime repository.

Preferred v0.3 approach:

1. keep the existing fixture/JSON as a development seed source if useful
2. provide a deterministic seed script or explicit seed command
3. write game items to the Games table
4. make the runtime Lambda read games only from DynamoDB

The JSON fixture must no longer be the production/runtime source of truth after migration.

Do not build an admin UI merely to seed data.

---

## 19. Migration strategy

Implement v0.3 incrementally.

### Step 1 — Persistence contracts

Confirm the current `GameRepository` and session repository abstractions are sufficient.

Only change interfaces when required by actual persistence behavior.

### Step 2 — DynamoDB infrastructure

Add:

```text
Games table
GameSessions table
IAM grants
Lambda table-name environment variables
```

### Step 3 — Game repository

Implement:

```text
DynamoDbGameRepository
```

Validate:

```text
GET /games
GET /games/{gameId}
```

### Step 4 — Seed

Load the existing playable game data into DynamoDB.

### Step 5 — Session repository

Implement:

```text
DynamoDbGameSessionRepository
```

### Step 6 — Durable game flow

Validate:

```text
POST /game-sessions
POST /game-sessions/{sessionId}/answers
GET /game-sessions/{sessionId}
```

across separate Lambda invocations.

### Step 7 — Remove runtime fallback

The deployed backend must not silently fall back to JSON or in-memory session storage.

Tests may continue using fakes/in-memory repositories.

---

## 20. Error handling

Existing HTTP mappings remain valid.

Persistence-specific failures must be translated at the infrastructure boundary.

Examples:

```text
Game missing                       -> application/domain not-found -> 404
Session missing                    -> application/domain not-found -> 404
Stale/duplicate session update     -> application conflict -> 409
Invalid request                    -> 400
Unexpected DynamoDB/AWS failure    -> internal error -> 500
```

Do not expose raw AWS SDK errors to the frontend.

---

## 21. Observability

Continue using CloudWatch Logs.

Add useful persistence context where appropriate:

```text
repository
operation
gameId
sessionId
durationMs
result
```

Do not log full game-session payloads or unnecessary personal information.

AWS SDK errors should be logged with enough technical context for diagnosis without returning internals to clients.

---

## 22. Testing strategy

### Domain tests

Remain AWS-free.

Test:

- scoring
- answer validation
- progression
- completion
- invalid/stale transitions

### Application tests

Use fake/in-memory repository implementations.

Test use cases independently from DynamoDB.

### Repository tests

Add focused tests for mapping between domain models and DynamoDB items.

Where practical, test conditional-update behavior.

Do not make all unit tests depend on a live AWS account.

### HTTP adapter tests

Preserve request/response and error mapping coverage.

### Infrastructure validation

At minimum:

```bash
npx cdk synth
```

### Project validation

Before completion:

```bash
npm run lint
npm test
npm run build
npx cdk synth
```

---

## 23. Security posture

v0.3 still has no user authentication.

Therefore:

- do not store sensitive personal information
- do not introduce identity assumptions into table keys
- use generated opaque session IDs
- keep IAM least-privilege
- keep DynamoDB inaccessible directly from the browser
- do not put AWS credentials in Next.js client code
- do not expose table names as part of public API contracts

Authentication and family identity remain deferred.

---

## 24. Repository structure

Preserve the current repository organization where possible.

Conceptual additions:

```text
src/
  domain/
  application/
  infrastructure/
    repositories/
      DynamoDbGameRepository.ts
      DynamoDbGameSessionRepository.ts
    dynamodb/
      mappers/
  interfaces/
    http/

infra/
  bin/
  lib/

scripts/
  seed-games.ts

docs/
  architecture/
    ARCHITECTURE-v0.3.md
    ADR-006-dynamodb-persistence.md
    ADR-007-dynamodb-data-model.md

docs/
  requirements/
    REQUIREMENTS-v0.3.md
```

Do not reorganize unrelated code merely to match this conceptual tree.

---

## 25. Definition of Done

Architecture v0.3 is implemented when:

- DynamoDB resources are defined in CDK.
- `cdk synth` succeeds.
- games are available from DynamoDB.
- runtime game retrieval no longer depends on local JSON.
- game sessions are stored durably in DynamoDB.
- a session created in one Lambda invocation can be read in another.
- submitted answers survive separate Lambda invocations.
- duplicate/stale answer submissions cannot silently advance the session twice.
- the complete playable family quiz still works.
- domain code has no AWS SDK/CDK/API Gateway dependencies.
- the frontend has no direct DynamoDB/AWS SDK dependency.
- Lambda has least-privilege table access.
- no authentication, AI, multiplayer or unrelated roadmap capability has been introduced.
- `npm run lint` passes.
- `npm test` passes.
- `npm run build` passes.
- `npx cdk synth` passes.

---

## 26. Architecture decisions

v0.3 is governed by all previously accepted ADRs plus:

- ADR-006 — Use Amazon DynamoDB for durable persistence
- ADR-007 — Use separate Games and GameSessions tables with simple primary keys

ADR-003, ADR-004 and ADR-005 remain valid.

---

## 27. Evolution beyond v0.3

v0.3 creates the persistent foundation required by later roadmap phases.

```text
v0.1
Local playable frontend
        |
        v
v0.2
Serverless HTTP backend
        |
        v
v0.3
Durable persistence
        |
        v
v0.4
AI-generated learning content
```

Later requirements may require new access patterns and table/index evolution.

Do not add those structures until the corresponding phase begins.

---

## 28. Summary

v0.3 intentionally changes one major thing:

```text
Temporary data
      |
      v
Durable data
```

Target architecture:

```text
Next.js
   |
   v
GameApiClient
   |
   v
API Gateway HTTP API
   |
   v
Lambda
   |
   v
Application / Domain
   |
   v
Repository Contracts
   |
   +--------------------+
   |                    |
   v                    v
DynamoDbGame        DynamoDbGameSession
Repository          Repository
   |                    |
   +---------+----------+
             |
             v
         DynamoDB
```

The key rule remains:

> DynamoDB is an infrastructure detail. The domain models the game; repositories isolate persistence; the frontend talks only to the backend HTTP API.
