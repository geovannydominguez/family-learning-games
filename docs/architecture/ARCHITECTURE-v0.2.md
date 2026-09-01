# Family Learning Games — Architecture v0.2

## 1. Status

**Version:** v0.2  
**Stage:** Phase 2 — Serverless Backend Foundation  
**Status:** Proposed architecture baseline before implementation

---

## 2. Purpose

v0.2 introduces the first AWS backend for Family Learning Games.

The objective is not to add new product capabilities. The objective is to evolve the architecture from a fully local application into a frontend + serverless backend model while preserving the complete playable experience achieved in v0.1.

Primary architectural goal:

> Move game access and game-session operations behind an HTTP API implemented with AWS serverless services without coupling the domain to AWS.

---

## 3. Context

v0.1 proved the primary product hypothesis: a family can open the application, select a game, answer all questions, receive immediate feedback, see the final score and play again.

The v0.1 architecture was intentionally local:

```text
Next.js
   |
   v
GameRepository
   |
   v
MockGameRepository
   |
   v
Local JSON
```

The next roadmap step is Phase 2: introduce a serverless AWS backend.

---

## 4. v0.2 goals

v0.2 must:

1. Introduce an HTTP backend.
2. Run the backend using AWS Lambda.
3. Expose the backend through Amazon API Gateway HTTP API.
4. Make the frontend communicate with the backend through HTTP.
5. Preserve domain logic independently from AWS.
6. Preserve repository abstraction.
7. Keep game data and session state non-persistent.
8. Provision AWS infrastructure using AWS CDK with TypeScript.
9. Provide minimum operational logging through CloudWatch.
10. Preserve the complete v0.1 playable flow.

---

## 5. Non-goals

v0.2 does not introduce persistent storage, DynamoDB, relational databases, authentication, Cognito, user accounts, family profiles, authorization, generative AI, Bedrock, OpenAI integration, multiplayer, WebSockets, AppSync, queues, EventBridge, Step Functions, advanced observability, microservices or native mobile applications.

These belong to later roadmap phases.

---

## 6. Target architecture

```text
┌───────────────────────────────┐
│            Browser            │
│    Family Learning Games      │
└───────────────┬───────────────┘
                │ HTTPS
                ▼
┌───────────────────────────────┐
│          Next.js UI           │
│       API Client Layer        │
└───────────────┬───────────────┘
                │ HTTPS / JSON
                ▼
┌───────────────────────────────┐
│   Amazon API Gateway HTTP API │
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
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│ Local / JSON Implementations  │
│ No persistent database yet    │
└───────────────────────────────┘
```

---

## 7. Architectural boundaries

### Frontend

Responsibilities: render the experience, navigate screens, call backend endpoints and present loading/error states.

It must not read game JSON directly, instantiate backend repositories, contain Lambda logic or depend on AWS SDK for the game flow.

### HTTP/API adapter

Responsibilities: receive API Gateway requests, map HTTP input to application commands, validate request structure, call use cases, map results to HTTP responses and write structured request logs.

It must not contain scoring or game rules.

### Application layer

Coordinates use cases such as `ListGames`, `GetGame`, `StartGameSession`, `SubmitAnswer` and `GetGameSession`.

It may depend on repository interfaces, but not on API Gateway or Lambda event formats.

### Domain layer

Owns games, questions, answers, sessions, scoring and game rules.

Domain code remains pure TypeScript and independent from AWS/HTTP.

### Repository layer

The application depends on repository contracts.

```ts
interface GameRepository {
  findAll(): Promise<Game[]>;
  findById(id: string): Promise<Game | null>;
}
```

For v0.2 a local/JSON implementation is acceptable. Durable persistence is deferred.

---

## 8. Candidate HTTP API

```text
GET  /games
GET  /games/{gameId}
POST /game-sessions
POST /game-sessions/{sessionId}/answers
GET  /game-sessions/{sessionId}
```

The exact implementation may use a smaller subset if the current domain model does not require all operations yet.

The rule is: implement the smallest coherent API that preserves the complete playable flow.

---

## 9. API design principles

Prefer JSON, explicit HTTP status codes, small DTOs, stable identifiers and error translation at the boundary.

Avoid exposing internal domain objects directly, AWS-specific metadata in responses, premature API versioning complexity and generic RPC endpoints such as `/executeAction`.

---

## 10. Lambda design

Recommended initial model:

```text
API Gateway HTTP API
        |
        v
Single Lambda HTTP entry point
        |
        v
Small internal router
        |
        v
Application use cases
```

This avoids unnecessary function fragmentation while the backend is small.

The Lambda handler is an adapter, not the application architecture.

---

## 11. Infrastructure

v0.2 infrastructure is provisioned with AWS CDK using TypeScript.

```text
FamilyLearningGamesBackendStack
        |
        +-- HTTP API
        +-- Lambda
        +-- Lambda execution role
        +-- CloudWatch logging
```

Infrastructure must be reproducible from code. Manual console configuration must not become the source of truth.

---

## 12. Observability

CloudWatch Logs is sufficient for v0.2.

Minimum structured fields when available:

```text
level
timestamp
requestId
method
path
statusCode
durationMs
```

Avoid logging unnecessary personal information.

---

## 13. Error handling

Candidate mapping:

```text
Invalid request              -> 400
Game not found               -> 404
Session not found            -> 404
Invalid answer/session state -> 409 or 400
Unexpected server error      -> 500
```

Domain/application code must not know HTTP status codes.

---

## 14. Session state in v0.2

v0.2 does not require durable session persistence.

Acceptable options include keeping session behavior frontend-managed, using an in-memory repository for architectural demonstration, or simplifying the remote flow so only the operations that clearly benefit from the backend are moved.

Important:

> Lambda memory must never be treated as persistent storage.

True persistence belongs to v0.3 / Phase 3.

---

## 15. Security posture

v0.2 intentionally has no user authentication.

Minimum expectations:

* HTTPS through API Gateway
* restrictive IAM permissions
* no secrets committed to source control
* no unnecessary AWS permissions
* CORS limited to required frontend origins when deployed
* no sensitive user data in logs

Authentication and family identities are deferred.

---

## 16. Testing strategy

### Domain tests

Test scoring, valid/invalid answers, game progression and final state without AWS.

### Application tests

Test use cases using fake/in-memory repositories.

### HTTP adapter tests

Test request mapping, required parameters, error mapping and response status/shape.

### Infrastructure validation

At minimum:

```bash
npx cdk synth
```

---

## 17. Deployment model

A minimal single environment such as `dev` is sufficient for v0.2.

Do not introduce a complex multi-account or multi-environment strategy yet.

---

## 18. Repository structure

Conceptual target:

```text
src/
  domain/
    game/
    session/
  application/
    game/
    session/
  infrastructure/
    repositories/
  interfaces/
    http/

infra/
  bin/
  lib/

docs/
  architecture/
```

Preserve meaningful existing conventions rather than reorganizing unnecessarily.

---

## 19. Migration from v0.1

1. Preserve current domain and application behavior.
2. Create the backend HTTP adapter.
3. Expose required operations through Lambda/API Gateway.
4. Create a frontend API client or `ApiGameRepository`.
5. Replace direct local-repository usage from the frontend.
6. Validate the complete game flow.

End state:

```text
Before
Frontend -> MockGameRepository -> JSON

After
Frontend -> HTTP API -> Lambda -> Application -> Repository -> JSON/local
```

---

## 20. Definition of Done

v0.2 is complete when:

* AWS CDK can synthesize the backend stack.
* API Gateway HTTP API routes requests to Lambda.
* Lambda can execute the approved game use cases.
* Domain logic contains no AWS dependencies.
* Frontend uses HTTP for the approved backend operations.
* The complete family quiz remains playable.
* Score and feedback behavior remain correct.
* Automated tests pass.
* Lint passes.
* Production build passes.
* No persistent database has been introduced.
* No authentication or AI capability has been introduced.

---

## 21. Architecture decisions

v0.2 is governed by:

* ADR-003 — Use AWS serverless backend
* ADR-004 — Use API Gateway HTTP API
* ADR-005 — Use AWS CDK with TypeScript

Existing accepted ADRs from v0.1 remain valid unless explicitly superseded.

---

## 22. Evolution beyond v0.2

```text
v0.2
Application -> Repository -> JSON / InMemory

v0.3
Application -> Repository -> DynamoDB
```

The repository boundary preserved in v0.2 is intended to make that evolution localized.

Later phases may introduce AI generation, public deployment maturity, family profiles, PWA capabilities, media and multiplayer. Those concerns must not distort v0.2.
