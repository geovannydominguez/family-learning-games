# Family Learning Games — AGENTS.md

## Project

Family Learning Games is an incremental family-oriented learning game platform.

The project must evolve progressively, preserving architectural clarity and avoiding unnecessary complexity.

Current target version:

> **v0.3 — Durable Persistence**

Current roadmap phase:

> **FASE 3 — Persistencia**

---

## Mandatory documentation to read first

Before changing code, read and follow these files:

1. `AGENTS.md`
2. `docs/architecture/ARCHITECTURE-v0.3.md`
3. `docs/architecture/ADR-006-dynamodb-persistence.md`
4. `docs/architecture/ADR-007-dynamodb-data-model.md`
5. `docs/architecture/REQUIREMENTS-v0.3.md`

Also review previous architecture decisions when relevant:

- `docs/architecture/ARCHITECTURE-v0.1.md`
- `docs/architecture/ARCHITECTURE-v0.2.md`
- `docs/architecture/ADR-001.md`
- `docs/architecture/ADR-002.md`
- `docs/architecture/ADR-003-serverless-backend.md`
- `docs/architecture/ADR-004-api-gateway-http-api.md`
- `docs/architecture/ADR-005-aws-cdk.md`

If requirements conflict, prefer the most recent accepted architecture/ADR for the current version.

Do not silently reinterpret architectural decisions.

---

## Current architecture

The target architecture for v0.3 is:

```text
Next.js
   │
   ▼
GameApiClient
   │
   ▼
API Gateway HTTP API
   │
   ▼
AWS Lambda
   │
   ▼
Application / Domain
   │
   ▼
Repository Contracts
   │
   ├──────────────────────────────┐
   ▼                              ▼
DynamoDbGameRepository     DynamoDbGameSessionRepository
   │                              │
   └──────────────┬───────────────┘
                  ▼
               DynamoDB
```

The main architectural change from v0.2 to v0.3 is:

> Replace runtime JSON/in-memory persistence with DynamoDB while preserving the existing domain/application boundaries and repository abstractions.

---

## Core engineering principles

These rules are mandatory.

### 1. Keep Domain AWS-independent

The domain layer must not depend on:

- AWS SDK
- DynamoDB types
- API Gateway event types
- Lambda runtime types
- CDK constructs
- environment variables

The domain must remain plain TypeScript.

### 2. Keep Application independent from infrastructure

Application/use-case code must depend on repository interfaces/contracts, not concrete DynamoDB implementations.

Correct:

```text
Application
   ↓
GameRepository
   ↓
DynamoDbGameRepository
```

Incorrect:

```text
Application
   ↓
DynamoDBDocumentClient
```

### 3. Infrastructure implements repository contracts

AWS-specific implementation belongs in infrastructure.

Examples:

```text
src/infrastructure/
├── persistence/
│   ├── DynamoDbGameRepository.ts
│   └── DynamoDbGameSessionRepository.ts
└── http/
```

Exact placement may follow the existing repository structure, but do not move unrelated code without a clear reason.

### 4. Preserve incremental architecture

Do not redesign the complete project.

Do not introduce abstractions because they might be useful someday.

Implement only what v0.3 requires.

Prefer:

```text
small change
→ tested
→ understandable
→ deployable
```

over:

```text
large future-proof redesign
```

### 5. Repository contracts remain the persistence boundary

The existing repository interfaces are intentional architectural boundaries.

Prefer adapting concrete implementations rather than changing domain/application APIs.

Change a repository contract only when the current contract cannot correctly express a v0.3 requirement.

If changing a contract is necessary:

1. explain why,
2. keep the change minimal,
3. update tests,
4. preserve separation of concerns.

---

## v0.3 persistence decisions

### DynamoDB is the persistence technology

Use Amazon DynamoDB for durable persistence.

Do not replace it with:

- RDS
- PostgreSQL
- Aurora
- MongoDB
- Redis
- S3-as-database

unless an accepted ADR explicitly changes this decision.

### Tables

v0.3 should remain simple.

Use two logical persistence models:

```text
Games
└── PK: gameId

GameSessions
└── PK: sessionId
```

Do not introduce a complex single-table design in v0.3.

Do not add secondary indexes unless an actual current access pattern requires them.

### Game persistence

A game may be stored as a single DynamoDB item containing its questions.

Conceptually:

```text
Game
├── gameId
├── title
├── category
├── difficulty
└── questions[]
```

Do not normalize questions/options into additional tables without a current requirement.

### Session persistence

Game sessions must survive Lambda container replacement/restart.

Do not use in-memory state as the runtime source of truth.

Session state stored in DynamoDB should support the current game flow, including:

- session identification,
- selected game,
- current question/progress,
- score,
- answers or state required by the existing use cases,
- completion state,
- concurrency/version information when needed.

Reuse existing domain models where practical.

Do not expose DynamoDB storage structures directly to the domain.

---

## Concurrency and idempotency

Persistence introduces concurrency concerns.

Session updates must not rely only on:

```text
read
→ modify
→ unconditional save
```

when concurrent requests could corrupt progress.

Use DynamoDB conditional writes / optimistic concurrency where required.

For example, an answer request should not be able to advance the same expected question twice.

Conceptually:

```text
expected currentQuestionIndex == persisted currentQuestionIndex
```

If the condition fails:

- return an application-level conflict/error,
- do not leak DynamoDB implementation details,
- do not silently overwrite the latest session state.

HTTP mapping may use `409 Conflict` when consistent with the existing API error model.

---

## Seed data

The current local JSON game data may remain in the repository as:

- fixture,
- seed input,
- development data.

But JSON must no longer be the runtime persistence source for the AWS backend.

Provide a simple repeatable seed mechanism for development.

Preferred concept:

```text
existing JSON
    ↓
seed script
    ↓
DynamoDB Games table
```

The seed mechanism should be safe to rerun when practical.

Do not build an admin UI for game management in v0.3.

---

## AWS CDK rules

Infrastructure remains managed with AWS CDK using TypeScript.

v0.3 CDK changes should include only what is necessary, such as:

- DynamoDB tables,
- Lambda environment variables containing table names,
- IAM permissions required by Lambda,
- outputs when useful.

Prefer least-privilege IAM.

Do not grant broad permissions such as:

```text
dynamodb:*
Resource: *
```

when table-scoped permissions can be used.

---

## Development environment and cost control

This is still a development-stage personal project.

Prefer DynamoDB on-demand billing for v0.3 unless an accepted ADR says otherwise.

Development resources should remain easy to destroy and recreate.

For disposable development tables, destructive removal behavior is acceptable when explicitly configured for the development stack.

Do not assume production retention policies yet.

Do not add unnecessary always-on AWS resources.

---

## Allowed changes in v0.3

The following are in scope:

- DynamoDB tables
- AWS SDK DynamoDB client usage inside infrastructure
- DynamoDB repository implementations
- repository wiring/composition changes
- Lambda IAM permissions for DynamoDB
- Lambda environment configuration for table names
- seed script for initial games
- persistence mapping code
- conditional writes / optimistic concurrency
- unit tests
- infrastructure tests where useful
- updates needed to preserve the existing API behavior
- small refactors necessary to support durable persistence

---

## Explicitly out of scope for v0.3

Do not introduce:

- Amazon Cognito
- user authentication
- family accounts
- family profiles
- child profiles
- AI-generated games
- Amazon Bedrock
- OpenAI integration
- SQS
- SNS
- EventBridge
- Step Functions
- WebSockets
- multiplayer
- leaderboards
- analytics pipelines
- Redis / ElastiCache
- RDS / Aurora
- GraphQL / AppSync
- S3 persistence for game/session records
- admin portal
- mobile native app
- PWA-specific features
- audio/image generation
- production-grade multi-environment platform redesign

These belong to later roadmap phases unless explicitly requested and approved.

---

## API compatibility

The frontend should continue consuming the backend through `GameApiClient`.

Do not make React components call DynamoDB or AWS SDKs directly.

Preserve the existing HTTP API contract whenever possible.

A persistence implementation change should not require unnecessary frontend rewrites.

If an API contract must change, make it explicit and keep it minimal.

---

## Error handling

Translate infrastructure errors into application/API errors.

Do not leak:

- DynamoDB exception names,
- AWS request IDs,
- table internals,
- stack traces,
- AWS SDK objects

to clients.

Expected error classes should remain meaningful at the application/API level.

Examples:

```text
GAME_NOT_FOUND
SESSION_NOT_FOUND
INVALID_ANSWER
SESSION_CONFLICT
MISSING_CONFIGURATION
```

Reuse existing conventions where they already exist.

---

## Configuration

Do not hardcode DynamoDB table names inside repository code.

Read them from environment/configuration supplied by infrastructure.

Fail fast with a clear configuration error if required configuration is missing.

Keep configuration access outside the domain layer.

---

## Testing requirements

Every implementation must preserve or improve existing tests.

At minimum validate:

- game retrieval from repository,
- game-not-found behavior,
- session creation,
- session retrieval,
- answer/progress persistence,
- score persistence,
- session completion,
- conditional update/conflict behavior,
- mapping between DynamoDB records and domain models.

Prefer unit tests for repository mapping and use cases.

Do not require live AWS services for the entire test suite.

Use dependency injection/fakes/mocks where appropriate.

---

## Validation before completion

Before declaring v0.3 complete, run:

```bash
npm run lint
npm test
npm run build
npx cdk synth
```

If the repository exposes additional relevant validation scripts, run them too.

Do not claim completion while these commands fail.

If a failure is pre-existing and unrelated, clearly report it.

---

## Implementation workflow for Codex / coding agents

When asked to implement v0.3:

1. Read this `AGENTS.md`.
2. Read the current architecture and ADRs.
3. Inspect the existing code before proposing changes.
4. Identify existing repository interfaces and composition roots.
5. Preserve current domain/application boundaries.
6. Implement infrastructure changes incrementally.
7. Add/update tests together with code.
8. Run validation commands.
9. Summarize:
   - files changed,
   - architectural changes,
   - tests executed,
   - AWS resources introduced,
   - any remaining manual deployment/seed steps.

Do not stop after merely generating a plan when the request is to implement.

Do not rewrite unrelated files for stylistic reasons.

---

## Preferred implementation order

For v0.3, prefer this sequence:

```text
1. Inspect current repository contracts
2. Add DynamoDB tables in CDK
3. Add IAM permissions and Lambda environment variables
4. Implement DynamoDbGameRepository
5. Add game seed mechanism
6. Wire DynamoDbGameRepository into AWS runtime
7. Implement DynamoDbGameSessionRepository
8. Add conditional session updates
9. Wire session repository into AWS runtime
10. Remove JSON/in-memory repositories from AWS runtime composition
11. Update/add tests
12. Validate complete HTTP flow
13. npm run lint
14. npm test
15. npm run build
16. npx cdk synth
```

JSON/in-memory implementations may remain for tests/local fixtures if still useful, but they must not remain the AWS runtime source of truth.

---

## Definition of Done — v0.3

v0.3 is complete when:

- games are loaded from DynamoDB at runtime,
- game sessions are stored durably in DynamoDB,
- session state survives Lambda container replacement,
- concurrent/stale session updates are protected where required,
- frontend continues using the existing API abstraction,
- domain and application layers remain AWS-independent,
- DynamoDB resources are defined through CDK,
- Lambda has least-privilege access to required tables,
- initial games can be seeded repeatably,
- lint/tests/build/CDK synth succeed,
- no v0.4+ feature has been introduced unnecessarily.

---

## Architectural rule of thumb

When unsure where code belongs, use this dependency direction:

```text
UI
 ↓
HTTP Client
 ↓
API / Lambda Adapter
 ↓
Application
 ↓
Domain
 ↑
Repository Contract
 ↑
Infrastructure Implementation
 ↑
AWS SDK / DynamoDB
```

Dependencies should point toward the application/domain core, never the opposite.

The goal of v0.3 is not to make the platform complex.

The goal is:

> **Keep the existing game playable, but make its backend state durable.**
