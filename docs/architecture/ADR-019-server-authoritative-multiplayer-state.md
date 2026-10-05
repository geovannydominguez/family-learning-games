# ADR-019 — Server-Authoritative Multiplayer State and Dedicated DynamoDB Coordination Table

- **Status:** Accepted
- **Date:** 2026-10-04
- **Phase:** FASE 9 — Multiplayer
- **Version:** v0.9

## Context

In multiplayer, several untrusted clients may act at almost the same time.

Examples:

```text
two players answer simultaneously
several clients report a timeout
the final answer races with the timeout
a client retries a message
a disconnected client reconnects
```

If browsers calculate their own authoritative scores, deadlines, or state transitions, players can observe inconsistent results and client-supplied data can be manipulated.

The existing `GameSessions` persistence was designed for the existing single-player flow. WebSocket connections, room membership, concurrent answers, and room-code lookup have different access patterns and expiration requirements.

## Decision

Multiplayer state is **server-authoritative**.

The backend is the only authority for:

```text
room state
question state
current question
question start/deadline
accepted answer
server receive time
correctness
correct-answer placement
points
scoreboard
final rank
```

Clients render state and send commands; they do not decide state.

Add one dedicated DynamoDB table for ephemeral multiplayer coordination.

Recommended name:

```text
<env>-family-learning-games-multiplayer
```

The existing tables remain unchanged:

```text
Games
GameSessions
Players
```

## State machine

Room:

```text
WAITING
  ↓
IN_PROGRESS
  ↓
FINISHED
```

Question:

```text
NOT_STARTED
  ↓
OPEN
  ↓
REVEALED
```

State transitions use conditional writes/version checks.

## Data model

Recommended logical items:

```text
ROOM
PLAYER_MEMBERSHIP
ANSWER
CONNECTION
```

Recommended key patterns:

```text
ROOM#<roomId> / META
ROOM#<roomId> / PLAYER#<playerId>
ROOM#<roomId> / ANSWER#<questionId>#<playerId>
CONNECTION#<connectionId> / META
```

A reservation item resolves the room code without scans or a GSI:

```text
CODE#<roomCode> / RESERVATION   →   roomId
```

It is written in the same transaction as the room and host membership. That makes it both the uniqueness constraint and a strongly consistent lookup.

TTL expires old rooms/connections.

## Why a dedicated table

The multiplayer table has requirements that are not a natural fit for existing single-player `GameSessions`:

- many writers per room;
- one answer item per player/question;
- connection reverse lookup;
- room-code lookup;
- temporary membership credentials;
- TTL-heavy state;
- concurrent conditional updates;
- reconnect state.

Keeping these concerns separate protects the existing single-player persistence contract and makes rollback/removal of multiplayer simpler.

## Concurrency rules

At minimum, persistence must guarantee:

```text
one room code reservation
one membership per room/player
one accepted answer per room/question/player
one OPEN → REVEALED transition per question
one logical scoring finalization per question
```

DynamoDB conditional writes and transactions are used where these invariants cross records.

Duplicate WebSocket messages are expected and must be safe.

## Timeout decision

The backend stores:

```text
questionStartedAt
questionDeadlineAt
```

and compares against server time.

The browser countdown is not authority.

v0.9 does not add EventBridge Scheduler or Step Functions for each question.

When a countdown expires, any client may send:

```text
QUESTION_TIMEOUT
```

The backend closes the question only if:

```text
serverNow >= questionDeadlineAt
AND questionState == OPEN
```

This trigger can be duplicated safely.

When all eligible players answer before the deadline, the last accepted answer can trigger the same closure path immediately.

Clients send `QUESTION_TIMEOUT` automatically when their server-estimated time reaches the deadline. An overdue question that is still `OPEN` is also closed by the next backend activity for the room (`IDENTIFY`/reconnect, `SYNC_ROOM`, `SUBMIT_ANSWER`, `QUESTION_TIMEOUT`, `NEXT_QUESTION`). All of these go through the same single reveal/scoring path.

Revealing the last question also sets `room.status = FINISHED` in the same atomic write and broadcasts `GAME_FINISHED`. No `NEXT_QUESTION` is needed after the final question.

## Scoring decision

Only correct answers receive points.

```text
BASE_CORRECT_POINTS = 1000
```

Speed bonus among correct responses:

```text
1st correct = +300
2nd correct = +200
3rd correct = +100
4th+ correct = +0
```

Question score:

```text
isCorrect
  ? 1000 + speedBonus(correctPlacement)
  : 0
```

Placement uses backend receive time, not a client timestamp.

A small configurable tie window (100 ms) assigns the same placement and bonus to near-simultaneous correct responses. Placement uses competition ranking: if A and B tie for 1st, both get +300 and the next correct answer is 3rd (+100), i.e. `1, 1, 3`.

## Final podium decision

Correctness has higher priority than speed.

Players are ordered by:

```text
1. correctAnswers                    DESC
2. totalPoints                       DESC
3. firstPlaceCorrectAnswers          DESC
4. secondPlaceCorrectAnswers         DESC
5. thirdPlaceCorrectAnswers          DESC
6. cumulativeCorrectResponseTimeMs   ASC
```

If all fields are equal, a tie may be declared.

This means first/second/third answer order affects the podium without allowing fast incorrect guessing to dominate an educational game.

## Alternatives considered

### Store all multiplayer state in the browser

Rejected.

It is inconsistent across devices and trusts untrusted clients.

### Let the host browser be authoritative

Rejected.

Host disconnection would stop the game, and a host client could manipulate score/state.

### Store multiplayer in existing `GameSessions`

Rejected for v0.9.

It would mix different access patterns and increase risk to the stable single-player model.

### Redis / ElastiCache

Rejected for v0.9.

The current scale does not justify a continuously provisioned in-memory data tier. DynamoDB conditional operations are sufficient for the required coordination model.

### Event sourcing

Rejected.

Append-only full event sourcing adds unnecessary complexity for this phase.

### Scheduler per question

Rejected for v0.9.

A server-validated client timeout trigger satisfies the requirement without another orchestration service.

## Consequences

### Positive

- one authoritative result on all devices;
- safe duplicate/retry handling;
- scalable managed persistence;
- single-player remains isolated;
- deterministic scoring;
- clear reconnection model.

### Negative

- adds one DynamoDB table;
- requires careful conditional-write design;
- timeout reveal is event-driven: API Gateway WebSocket and Lambda are event-driven. If every connected client disappears and no backend invocation occurs after the deadline, the question cannot transition from OPEN to REVEALED until new activity reaches the backend; the next activity then closes it (accepted for v0.9, no scheduler);
- server receive time includes network latency and is not a perfect measure of human reaction time.

The last limitation is acceptable for a family game and is safer than trusting device clocks.

## Result

Multiplayer v0.9 is:

```text
server authoritative
+
DynamoDB coordinated
+
idempotent
+
accuracy-first / speed-aware
```
