# Family Learning Games — Requirements v0.3

## 1. Scope

**Roadmap phase:** Phase 3 — Persistence  
**Architecture baseline:** `ARCHITECTURE-v0.3.md`

Primary outcome:

> The deployed backend must persist games and game-session progress in DynamoDB so application state survives independent Lambda invocations.

---

## 2. Functional requirements

### FR-001 — Persist game catalog

The backend shall obtain playable games from DynamoDB.

Acceptance criteria:

- `GET /games` returns the seeded game catalog from DynamoDB.
- The deployed Lambda does not use the local JSON fixture as its runtime source of truth.
- Existing game IDs and user-visible game behavior are preserved where practical.

### FR-002 — Get persisted game

The backend shall obtain one game by `gameId` from DynamoDB.

Acceptance criteria:

- `GET /games/{gameId}` returns the correct game.
- Unknown `gameId` returns the existing not-found response behavior.
- AWS-specific errors are not exposed to the client.

### FR-003 — Persist newly created game session

Starting a game shall create a durable session.

Acceptance criteria:

- `POST /game-sessions` persists a `GameSession`.
- The response returns an opaque `sessionId`.
- The persisted record identifies the selected `gameId`.
- The session can be retrieved from a later Lambda invocation.

### FR-004 — Retrieve persisted session

The backend shall load a game session by `sessionId`.

Acceptance criteria:

- `GET /game-sessions/{sessionId}` reads from DynamoDB.
- A session created previously remains available after the originating Lambda invocation has ended.
- Unknown sessions return the existing not-found behavior.

### FR-005 — Persist submitted answer

Submitting an answer shall durably update the session.

Acceptance criteria:

- the selected answer is persisted
- score is persisted
- current progress is persisted
- session status is persisted
- a later request observes the updated state

### FR-006 — Complete session durably

Completing the final question shall persist final game state.

Acceptance criteria:

- status becomes the domain-approved completed state
- final score remains available
- completion time is recorded if supported by the current domain model
- retrieving the session later returns the completed result

### FR-007 — Protect session progression from duplicate/stale updates

The backend shall not silently apply stale or duplicate answer transitions.

Acceptance criteria:

- repository update uses conditional/optimistic persistence
- an invalid concurrent/stale transition results in an application conflict
- HTTP boundary maps the conflict to `409` or the already-approved equivalent
- duplicate requests do not increment score/progress twice

### FR-008 — Seed initial games

The project shall provide a reproducible way to populate the DynamoDB Games table with the existing playable content.

Acceptance criteria:

- seed process is documented or implemented as a script
- repeated execution is deterministic/idempotent where practical
- runtime Lambda does not seed automatically on every request
- no admin UI is required

---

## 3. Architecture requirements

### AR-001 — Preserve repository boundary

Application/domain code shall depend on repository contracts rather than DynamoDB SDK APIs.

### AR-002 — DynamoDB remains infrastructure-only

AWS SDK DynamoDB types and commands shall exist only in infrastructure/composition code.

### AR-003 — Frontend remains AWS-independent

Next.js client code shall not access DynamoDB directly and shall not contain AWS credentials.

### AR-004 — Preserve existing HTTP boundary

The frontend shall continue using the existing backend HTTP API through `GameApiClient` or the current equivalent.

### AR-005 — Preserve serverless backend

v0.3 shall retain API Gateway HTTP API + AWS Lambda unless a separate accepted ADR explicitly supersedes that decision.

### AR-006 — Preserve CDK

DynamoDB tables, IAM access and Lambda configuration shall be represented in AWS CDK with TypeScript.

### AR-007 — Two-table v0.3 persistence model

v0.3 shall use:

```text
Games(gameId)
GameSessions(sessionId)
```

No GSI is required without a concrete implemented access pattern.

---

## 4. Non-functional requirements

### NFR-001 — Durability

Application correctness shall not depend on Lambda memory, execution-environment reuse or Lambda local filesystem state.

### NFR-002 — Cost efficiency

DynamoDB tables shall use on-demand capacity for the initial workload.

### NFR-003 — Least privilege

Lambda shall receive only the DynamoDB permissions required for the two application tables.

Broad `dynamodb:*` permissions are not acceptable.

### NFR-004 — Maintainability

DynamoDB item mapping shall be isolated from domain entities.

Persistence implementation shall remain replaceable behind repository contracts.

### NFR-005 — Testability

Domain and application unit tests shall run without requiring a live AWS account.

### NFR-006 — Observability

Persistence failures shall produce useful structured CloudWatch logs without exposing raw AWS internals to API clients.

### NFR-007 — Security/privacy

v0.3 shall not persist sensitive personal information because authentication/family profiles are not part of this phase.

### NFR-008 — API compatibility

Persistence migration shall not intentionally alter existing scoring, feedback, progress or replay behavior.

### NFR-009 — Development cleanup

The development stack shall support complete resource cleanup through CDK according to the chosen development removal policies.

---

## 5. Infrastructure requirements

### IR-001 — Games table

CDK shall create a DynamoDB Games table with:

```text
Partition key: gameId (string)
Capacity: on-demand
```

### IR-002 — GameSessions table

CDK shall create a DynamoDB GameSessions table with:

```text
Partition key: sessionId (string)
Capacity: on-demand
```

### IR-003 — Lambda environment configuration

CDK shall provide table names to the Lambda through environment variables or the current infrastructure configuration mechanism.

Expected semantic configuration:

```text
GAMES_TABLE_NAME
GAME_SESSIONS_TABLE_NAME
```

### IR-004 — IAM grants

CDK shall grant only required read/write operations for the corresponding tables.

### IR-005 — Development lifecycle

The `dev` stack shall use a table removal/lifecycle policy consistent with disposable development data so stack cleanup does not leave unintended resources.

### IR-006 — No additional persistence services

v0.3 shall not introduce RDS, Aurora, Redis, OpenSearch or other persistence infrastructure.

---

## 6. Data requirements

### DR-001 — Stable identifiers

Game and session IDs shall be stable strings.

Session IDs shall be opaque and generated by the backend/domain/application boundary.

### DR-002 — Game aggregate

A game item shall contain the data required to play the current quiz without requiring speculative normalized tables.

### DR-003 — Session aggregate

A session item shall contain the current durable game-progress state required by current use cases.

### DR-004 — Timestamps

Persist timestamps in a consistent UTC/ISO-8601 representation unless the current codebase already defines another accepted convention.

### DR-005 — Version/evolution tolerance

Persistence mapping should tolerate additive fields where practical.

Do not create a generic schema-versioning framework unless a concrete migration requires it.

---

## 7. Testing requirements

### TR-001 — Existing tests

Existing domain/application tests shall continue to pass.

### TR-002 — Repository mapping

Tests shall validate mapping between DynamoDB persistence records and domain models.

### TR-003 — Durable session behavior

Tests shall demonstrate that session operations do not rely on an in-memory singleton.

### TR-004 — Duplicate/stale answer protection

Tests shall cover the conflict path for an invalid expected session state.

### TR-005 — API regression

The complete playable flow shall remain valid through the HTTP API.

### TR-006 — Infrastructure

The infrastructure shall successfully synthesize:

```bash
npx cdk synth
```

### TR-007 — Project quality gates

Before v0.3 completion:

```bash
npm run lint
npm test
npm run build
npx cdk synth
```

must pass.

---

## 8. Explicit exclusions

Coding agents must not add the following while implementing these requirements unless separately requested and documented:

```text
Cognito
authentication
authorization
family profiles
player accounts
Bedrock
OpenAI
AI generation
S3 asset architecture
CloudFront redesign
WAF
AppSync
WebSockets
SQS
SNS
EventBridge
Step Functions
RDS
Aurora
Redis
OpenSearch
GraphQL
microservices
CQRS
event sourcing
leaderboards
analytics platform
admin portal
```

---

## 9. Definition of Done

v0.3 is done when this scenario succeeds:

```text
1. Deploy backend stack.
2. Seed game catalog into DynamoDB.
3. Open the application.
4. List/select a persisted game.
5. Start a game.
6. Receive a persisted sessionId.
7. Submit an answer.
8. Read the session from a separate request/Lambda invocation.
9. Confirm answer, score and progress are still present.
10. Complete all questions.
11. Retrieve the completed session.
12. Confirm final state and score remain persisted.
13. Replay/start another game without breaking existing behavior.
14. Run lint, tests, build and cdk synth successfully.
```

Additionally:

- deployed runtime has no JSON/in-memory persistence fallback
- domain remains AWS-independent
- frontend remains DynamoDB-independent
- Lambda IAM is least-privilege
- dev stack can be cleaned up intentionally
- no Phase 4+ capability has been introduced

---

## 10. Suggested implementation order for Codex

```text
1. Read AGENTS.md + ARCHITECTURE-v0.3 + ADR-003..007.
2. Inspect current repository contracts and v0.2 implementation.
3. Add DynamoDB tables in CDK.
4. Add Lambda configuration/IAM.
5. Implement DynamoDbGameRepository.
6. Add deterministic game seed.
7. Replace runtime JsonGameRepository wiring.
8. Implement DynamoDbGameSessionRepository.
9. Add conditional session updates.
10. Replace runtime in-memory session wiring.
11. Add/update tests.
12. Validate full HTTP game flow.
13. Run lint/test/build/cdk synth.
14. Do not introduce unrelated roadmap capabilities.
```
