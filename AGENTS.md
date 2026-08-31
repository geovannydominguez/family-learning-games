# Family Learning Games — Agent Guide

## Product goal

Family Learning Games starts as a small family learning game and may evolve later into a public educational platform.

The current priority is:

> Be able to play a complete game with the family.

Do not optimize prematurely for future scale.

---

## Current stage

We are currently building:

**v0.1 — local playable frontend**

Current architecture:

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

Everything required for v0.1 must work locally without a backend.

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

Do not upgrade major framework versions unless explicitly requested.

---

## Architecture decisions

Before making architectural changes, read:

* `docs/architecture/ADR-001.md`
* `docs/architecture/ADR-002.md`

These ADRs are the current source of truth for accepted architecture decisions.

If implementation conflicts with an accepted ADR, preserve the ADR unless the user explicitly requests a change.

Do not silently change architecture decisions.

---

## Core architecture principle

Preserve this boundary:

```text
UI
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

The UI must not directly import or depend on the local JSON data source.

The purpose of `GameRepository` is to allow this future replacement:

```text
MockGameRepository
        |
        v
ApiGameRepository
```

without rewriting game presentation components.

Do not introduce additional layers unless there is a concrete requirement.

---

## v0.1 functional goal

The application must support a complete playable flow:

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

The first game is a simple quiz.

Initial scope:

* 5 questions
* 4 answer options
* exactly 1 correct answer
* immediate correct/incorrect feedback
* current question progress
* accumulated score
* final result
* replay capability

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

---

## Coding principles

Prefer:

* strict TypeScript
* descriptive names
* small understandable components
* simple functions
* explicit code over clever abstractions
* clear separation between game logic and presentation when useful
* reusable components only when there is real reuse
* minimal dependencies

Avoid premature abstraction.

Do not build architecture for hypothetical future requirements.

---

## Explicitly out of scope for v0.1

Do not introduce:

* AWS Cognito
* Amazon Bedrock
* DynamoDB
* API Gateway
* Lambda
* WebSockets
* EventBridge
* CloudFront configuration
* WAF
* CDK
* Polly
* authentication
* remote backend APIs
* databases
* Redux
* Zustand
* React Query
* dependency injection frameworks
* CQRS
* Event Bus
* formal DDD
* full Clean Architecture
* microservices

Do not create placeholders, factories, adapters or abstractions for these technologies unless explicitly requested.

---

## Evolution strategy

The project evolves by replacing pieces progressively.

### Current

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

### Future

```text
Next.js
   |
   v
GameRepository
   |
   v
ApiGameRepository
   |
   v
Backend API
```

Future infrastructure must only be introduced when the roadmap reaches that stage.

---

## Decision rule

When choosing between:

1. a simple solution that solves the current requirement, and
2. a more flexible solution designed for hypothetical future requirements,

choose the simple solution.

Only introduce additional complexity when there is a concrete approved requirement.

---

## Working with existing code

Before changing code:

1. Inspect the existing project structure.
2. Preserve useful existing conventions.
3. Remove boilerplate only when it is no longer useful.
4. Prefer modifying existing files over introducing unnecessary abstractions.
5. Keep changes within the requested scope.

Do not stop after scaffolding if the task asks for working functionality.

---

## Validation

Before completing a coding task, run:

```bash
npm run lint
npm run build
```

Fix errors introduced by the change.

Do not leave known build or lint errors caused by the implementation.

---

## Completion report

At the end of a task, summarize:

* files created
* files modified
* important implementation decisions
* validation performed
* functionality deliberately excluded to preserve the current scope
