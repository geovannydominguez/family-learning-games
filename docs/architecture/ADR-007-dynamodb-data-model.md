# ADR-007 — Use Separate Games and GameSessions DynamoDB Tables

## Status

Accepted for v0.3.

---

## Context

After choosing DynamoDB for v0.3, the project needs a data model for two current aggregates:

```text
Game
GameSession
```

Current access patterns are intentionally small.

Games:

```text
List games
Get game by gameId
```

Sessions:

```text
Create session
Get session by sessionId
Persist answer/progress
Complete session
```

The project does not currently require:

- session lookup by authenticated player
- family history
- leaderboards
- analytics queries
- complex cross-entity queries
- multi-tenant partition design

Candidate designs include:

1. one single-table DynamoDB design using generic PK/SK patterns
2. separate simple tables for games and sessions
3. normalized tables for games/questions/options/sessions/answers

---

## Decision

Use **two DynamoDB tables**:

```text
Games
  PK: gameId

GameSessions
  PK: sessionId
```

Store each small game definition as a single game item.

Store each current game session as a single session item containing its current answer/progress state.

Do not introduce secondary indexes until an implemented access pattern requires one.

---

## Rationale

This is the simplest model that cleanly supports all v0.3 access patterns.

It keeps the implementation understandable while the project is small and avoids forcing single-table or normalized complexity before the application has the access patterns that justify it.

The repository boundary allows the persistence model to evolve later without exposing table structure to the frontend or domain.

---

## Game item

Conceptual shape:

```json
{
  "gameId": "animals-easy-001",
  "title": "Animals",
  "category": "animals",
  "difficulty": "easy",
  "questions": [],
  "version": 1,
  "createdAt": "...",
  "updatedAt": "..."
}
```

A game and its small question set form one read-oriented aggregate for the current application.

---

## GameSession item

Conceptual shape:

```json
{
  "sessionId": "uuid",
  "gameId": "animals-easy-001",
  "status": "IN_PROGRESS",
  "currentQuestionIndex": 0,
  "score": 0,
  "answers": [],
  "createdAt": "...",
  "updatedAt": "...",
  "completedAt": null
}
```

The session item is updated as the player progresses.

---

## Concurrency requirement

Session answer updates must use optimistic/conditional persistence semantics so a stale or duplicate request cannot silently apply the same transition twice.

A repository implementation may verify expected fields such as:

```text
status
currentQuestionIndex
```

using DynamoDB conditional expressions.

The application must receive a technology-neutral conflict result.

---

## Consequences

### Positive

- very easy to understand
- simple CDK infrastructure
- direct primary-key access
- no speculative generic PK/SK schema
- no unnecessary joins/normalization
- independent lifecycle for catalog and sessions
- easy repository mapping

### Negative

- `GET /games` initially uses a small table scan
- future access patterns may require GSIs
- larger games could eventually need a different storage shape
- future family/player history may require session indexing or additional aggregates

These are acceptable because those requirements are not part of v0.3.

---

## Rejected alternatives

### Single-table design

Not selected for v0.3.

Single-table DynamoDB design can be powerful when multiple known access patterns and related entities benefit from colocated partition/sort-key structures.

The current project does not yet have enough access patterns to justify that complexity.

Do not use single-table design merely as a scalability ritual.

### Fully normalized DynamoDB model

Not selected because splitting games, questions, options and answers into many items/tables would increase reads, mapping and transaction complexity without current benefit.

### One table for all data with a generic type field

Not selected because it adds key-schema conventions without a current cross-aggregate access requirement.

---

## Revisit when

Reconsider if future phases introduce concrete access patterns such as:

```text
list sessions by player
list recent sessions by family
leaderboards
progress history
game authoring/version history
large generated games
analytics-oriented queries
```

At that point, add only the indexes or model changes required by those access patterns and capture significant changes in a new ADR.
