# Family Learning Games — Agent Guide

## Product goal

Family Learning Games starts as a small family learning game and may evolve later into a public educational platform.

The current priority remains:

> Be able to play a complete game with the family while evolving the architecture progressively and intentionally.

Do not optimize prematurely for hypothetical future scale.

---

## Current stage

We are currently building:

**v0.2 — Serverless Backend Foundation**

The goal of v0.2 is to introduce the first AWS serverless backend while preserving the complete playable experience achieved in v0.1.

Target architecture:

```text
Browser
   |
   v
Next.js
   |
   | HTTPS
   v
API Gateway HTTP API
   |
   v
AWS Lambda
   |
   v
Application Layer
   |
   v
Domain
   |
   v
Repository abstraction
   |
   v
Local / JSON implementation
```

The frontend must stop reading game data directly from local repositories.

The backend becomes the owner of game retrieval and game-session operations.

---

## Technology baseline

Current project baseline:

* Next.js 15.5.x
* React 19
* TypeScript
* App Router
* Tailwind CSS
* ESLint
* npm

v0.2 additionally introduces:

* AWS Lambda
* Amazon API Gateway HTTP API
* AWS CDK with TypeScript
* Amazon CloudWatch Logs

Do not upgrade major framework versions unless explicitly requested.

Do not introduce additional AWS services unless they are required by the approved v0.2 scope.

---

## Architecture source of truth

Before making architectural changes, read:

* `docs/architecture/ARCHITECTURE-v0.2.md`
* `docs/architecture/ADR-001.md`
* `docs/architecture/ADR-002.md`
* `docs/architecture/ADR-003-serverless-backend.md`
* `docs/architecture/ADR-004-api-gateway-http-api.md`
* `docs/architecture/ADR-005-aws-cdk.md`

These documents are the current source of truth for accepted architecture decisions.

If implementation conflicts with an accepted ADR, preserve the ADR unless the user explicitly requests a change.

Do not silently replace, bypass or reinterpret accepted architecture decisions.

---

## Core architecture principles

### 1. Preserve domain independence

AWS infrastructure must not leak into domain logic.

The domain must not import:

* API Gateway event types
* Lambda context types
* CDK constructs
* AWS SDK clients
* HTTP-specific DTOs

AWS-specific code belongs at the infrastructure or interface boundary.

Preferred direction:

```text
HTTP / AWS Adapter
        |
        v
Application
        |
        v
Domain
        |
        v
Repository Port
        |
        v
Repository Implementation
```

### 2. Frontend communicates through HTTP

v0.1 allowed:

```text
Next.js
   |
   v
GameRepository
   |
   v
MockGameRepository
```

v0.2 must evolve toward:

```text
Next.js
   |
   v
ApiGameRepository / API Client
   |
   v
Backend HTTP API
```

The frontend must not directly import backend repository implementations or local JSON sources.

### 3. Preserve repository abstraction

Application and domain code must depend on repository contracts, not concrete persistence technology.

Example:

```ts
interface GameRepository {
  findAll(): Promise<Game[]>;
  findById(id: string): Promise<Game | null>;
}
```

For v0.2, a local or JSON-backed implementation is acceptable.

The purpose is to allow a later replacement such as:

```text
JsonGameRepository
        |
        v
DynamoDbGameRepository
```

without rewriting domain rules.

Do not introduce DynamoDB in v0.2.

### 4. Keep the backend small

The backend is not a microservices platform.

Prefer:

* one small backend stack
* one API Gateway HTTP API
* one or a very small number of Lambda functions
* simple routing
* direct application use cases
* minimal dependencies

Avoid splitting functions or services by hypothetical future scale.

---

## v0.2 functional goal

The complete v0.1 game flow must continue to work:

```text
Home
  |
  v
Choose game
  |
  v
Start game
  |
  v
Answer question
  |
  v
Immediate feedback
  |
  v
Next question
  |
  v
Final result
  |
  v
Play again
```

The difference is architectural:

> The browser retrieves and submits game information through the AWS backend API.

The first game remains a simple quiz.

Initial game scope remains:

* 5 questions
* 4 answer options
* exactly 1 correct answer
* immediate correct/incorrect feedback
* current question progress
* accumulated score
* final result
* replay capability

Do not expand product scope merely because a backend now exists.

---

## Initial HTTP API

The backend should expose only the operations required to preserve the playable flow.

Candidate API:

```text
GET  /games
GET  /games/{gameId}
POST /game-sessions
POST /game-sessions/{sessionId}/answers
GET  /game-sessions/{sessionId}
```

The exact implementation may be simplified if the current domain model does not require every endpoint yet.

Do not create unused endpoints only to match a future-looking API design.

Prefer the smallest contract that supports the current flow cleanly.

---

## Backend layering

Preferred responsibility boundaries:

```text
src/
  domain/
  application/
  infrastructure/
  interfaces/
```

### `domain/`

Pure business concepts and rules: Game, Question, Answer, GameSession, scoring and validation.

Must remain independent from AWS and HTTP.

### `application/`

Use cases and orchestration such as ListGames, GetGame, StartGameSession, SubmitAnswer and GetGameSession.

Application code may depend on repository interfaces.

### `infrastructure/`

Technology-specific implementations such as JsonGameRepository, in-memory session repository and AWS-specific wiring.

### `interfaces/`

Inbound adapters such as Lambda HTTP handlers, request mapping, response mapping and HTTP validation.

Do not introduce additional layers unless a concrete requirement justifies them.

---

## Serverless runtime

v0.2 uses:

```text
Amazon API Gateway HTTP API
        |
        v
AWS Lambda
```

Do not introduce ECS, EKS, EC2, App Runner or containers for the application runtime unless the architecture is explicitly reconsidered through a new ADR.

---

## Infrastructure as Code

AWS resources for v0.2 must be managed with:

> AWS CDK + TypeScript

Do not create the project architecture manually in the AWS Console as the source of truth.

Expected resources:

```text
FamilyLearningGamesBackendStack
        |
        +-- API Gateway HTTP API
        +-- Lambda
        +-- IAM permissions
        +-- CloudWatch Logs
```

Do not add speculative infrastructure.

---

## Observability

Use structured application logging where practical.

Useful minimum request context:

```text
requestId
timestamp
method
path
statusCode
durationMs
```

CloudWatch Logs is sufficient for v0.2.

Do not introduce advanced observability platforms without an approved requirement.

---

## UX principles

The application is initially intended for family use, including small children.

Prefer:

* large touch targets
* simple navigation
* readable typography
* few decisions per screen
* clear feedback
* responsive mobile, tablet and desktop layouts
* playful but simple visuals

Avoid dense interfaces and unnecessary configuration.

Backend evolution must not degrade the simple family experience.

---

## Coding principles

Prefer:

* strict TypeScript
* descriptive names
* small understandable components
* simple functions
* explicit code over clever abstractions
* clear separation between game logic and presentation
* repository contracts at real architectural boundaries
* minimal dependencies
* testable domain and application code

Avoid premature abstraction.

Do not build architecture for hypothetical future requirements.

---

## Explicitly out of scope for v0.2

Do not introduce:

* DynamoDB
* Aurora
* RDS
* databases
* persistent game sessions
* AWS Cognito
* authentication
* user accounts
* family profiles
* authorization
* Amazon Bedrock
* OpenAI integration
* generative AI
* automatic question generation
* image generation
* Amazon Polly
* audio generation
* multiplayer
* WebSockets
* AWS AppSync
* EventBridge
* SQS
* SNS
* Step Functions
* WAF
* complex CloudFront configuration
* microservices
* CQRS
* Event Bus
* formal DDD
* dependency injection frameworks
* Redux
* Zustand

React Query should only be introduced if there is a concrete frontend data-fetching need that materially improves the implementation. It is not required by v0.2.

Do not create placeholders for out-of-scope technologies.

---

## Evolution strategy

### v0.1

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

### v0.2

```text
Next.js
   |
   v
HTTP API Client
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
Repository
   |
   v
Local / JSON implementation
```

### Planned next stage

v0.3 / Phase 3 introduces persistence:

```text
Repository
   |
   v
DynamoDbRepository
```

Persistence must be introduced only when that roadmap phase begins.

---

## Decision rule

When choosing between:

1. a simple solution that solves the current approved v0.2 requirement, and
2. a more flexible solution designed for hypothetical future requirements,

choose the simple solution.

Only introduce additional complexity when there is a concrete approved requirement or an accepted ADR.

---

## Working with existing code

Before changing code:

1. Inspect the existing project structure.
2. Read the current architecture document and ADRs.
3. Preserve useful existing conventions.
4. Reuse the domain and application logic created in v0.1 where appropriate.
5. Prefer modifying existing files over duplicating concepts.
6. Keep AWS-specific code outside the domain.
7. Keep changes within the requested v0.2 scope.

Do not stop after scaffolding if the task asks for working functionality.

---

## API compatibility principle

When migrating the v0.1 frontend to the backend:

* preserve user-visible behavior
* preserve game rules
* preserve scoring behavior
* preserve immediate feedback
* preserve replay behavior

Architectural migration must not silently change product behavior.

---

## Validation

Before completing a coding task, run:

```bash
npm run lint
npm test
npm run build
```

If infrastructure validation applies, also run:

```bash
npx cdk synth
```

Fix errors introduced by the change.

Do not leave known build, lint, test or CDK synthesis errors caused by the implementation.

---

## Completion report

At the end of a task, summarize:

* files created
* files modified
* important implementation decisions
* API routes created or changed
* AWS resources created or changed
* validation performed
* functionality deliberately excluded to preserve v0.2 scope
