# Family Learning Games — Requirements v0.9

## 1. Document purpose

This document defines the functional and non-functional requirements for **FASE 9 — Multiplayer**, delivered as **v0.9**.

The goal of this phase is to allow several family players to participate in the same quiz from different devices, with synchronized questions, server-authoritative answers and scoring, and a live podium.

This phase is incremental. Existing single-player gameplay, AI generation, PWA behavior, player profiles, audio, images, and public hosting must continue to work.

---

## 2. Baseline

v0.9 builds on the accepted v0.8 baseline:

- Next.js / React / TypeScript frontend.
- Installable online-first PWA hosted with AWS Amplify.
- Existing HTTP API Gateway API.
- One existing backend Lambda.
- DynamoDB persistence for `Games`, `GameSessions`, and `Players`.
- Persisted family `Player` profiles.
- Amazon Bedrock game generation and validation.
- Private S3 media.
- Amazon Polly question audio with S3 caching.
- No Cognito, login, user accounts, JWTs, or family accounts.

All previous accepted ADRs remain valid unless explicitly superseded.

---

## 3. Scope

### 3.1 In scope

v0.9 MUST support:

1. Multiplayer rooms.
2. One host per room.
3. Multiple players using different devices.
4. Joining a room using a short room code.
5. Selecting an existing `Player` profile when creating or joining.
6. Real-time room state through WebSockets.
7. Synchronized quiz questions.
8. One answer per player per question.
9. Server-authoritative answer acceptance.
10. A configurable question time limit.
11. Automatic reveal when:
    - every active player has answered; or
    - the question deadline has expired.
12. Server-authoritative correctness evaluation.
13. Speed-aware points for correct answers.
14. Live scoreboard / podium.
15. Final winner determination.
16. Temporary disconnect and reconnect of an existing room member.
17. Multiplayer state expiration through DynamoDB TTL.
18. Existing single-player mode without regressions.

### 3.2 Explicitly out of scope

v0.9 MUST NOT introduce:

- Amazon Cognito.
- Username/password login.
- OAuth/social login.
- family/user accounts.
- permanent authentication or authorization.
- AppSync.
- GraphQL.
- Redis or ElastiCache.
- ECS, EKS, EC2, or containers.
- a second gameplay backend Lambda.
- EventBridge-based multiplayer orchestration.
- Step Functions for room/question progression.
- offline multiplayer.
- Bluetooth or local-network peer-to-peer play.
- voice/video chat.
- public matchmaking.
- friend lists.
- invitations by email/SMS.
- spectator mode.
- host migration.
- mid-game joining by a new player.
- persistent global leaderboards.
- prizes, coins, or monetization.
- new game types; those remain a later phase.

---

## 4. Multiplayer concepts

### 4.1 Room

A multiplayer game is coordinated through a temporary room.

A room has at least:

```text
roomId
roomCode
gameId
hostPlayerId
status
currentQuestionIndex
questionState
questionStartedAt
questionDeadlineAt
questionTimeLimitSeconds
createdAt
expiresAt
```

Recommended room states:

```text
WAITING
IN_PROGRESS
FINISHED
EXPIRED
```

Recommended question states while a room is in progress:

```text
NOT_STARTED
OPEN
REVEALED
```

### 4.2 Host

The player that creates the room becomes the `HOST`.

The host MAY:

- start the game;
- open the next question after the current question is revealed.

The host MUST NOT be able to:

- modify correctness;
- modify received answer times;
- assign points;
- override another player's answer;
- reveal a question before the backend permits it.

### 4.3 Participant

Every room member corresponds to an existing persisted `Player`.

A player profile is still a family profile, not an authenticated user account.

Recommended room-member roles:

```text
HOST
PLAYER
```

### 4.4 Room code

The backend generates a short, human-friendly room code.

Recommended v0.9 format:

```text
6 uppercase characters
```

The alphabet SHOULD avoid visually ambiguous characters when practical.

Example:

```text
AB7K2M
```

The room code is a discovery/convenience identifier. It MUST NOT be treated as an authentication secret.

Room-code creation MUST be collision-safe using a conditional write and bounded retry.

v0.9 reserves each code with a `CODE#<roomCode> / RESERVATION` item, written in the same transaction as the room. The same item resolves `roomCode → roomId` with a strongly consistent key read: no GSI and no table scan.

---

## 5. Player capacity

v0.9 SHOULD support:

```text
minimum players: 2
maximum players: 8
```

The maximum SHOULD be configurable through infrastructure/application configuration rather than embedded in Domain.

A room MUST reject new members once the game has started.

An existing member MAY reconnect after the game starts.

---

## 6. Room creation flow

The host flow is:

```text
Select Player
    ↓
Select Game
    ↓
Create Multiplayer Room
    ↓
Backend creates room
    ↓
Backend returns roomCode + temporary participant token
    ↓
Host opens WebSocket
    ↓
Host identifies the connection
    ↓
Lobby is displayed
```

Recommended HTTP operation:

```http
POST /multiplayer/rooms
```

Request:

```json
{
  "gameId": "game-id",
  "playerId": "player-id",
  "questionTimeLimitSeconds": 30,
  "difficulty": "easy"
}
```

`questionTimeLimitSeconds` is optional (default 30, range 10–120).

`difficulty` is optional and uses the existing `Difficulty` values (`easy`, `normal`, `hard`). It selects which of the game's questions are played, because seeded games contain several difficulties. When it is omitted, the game's first available difficulty is used, which keeps AI-generated games (one difficulty) working unchanged. The room snapshots up to 10 questions of that difficulty in persisted order. There is no separate multiplayer difficulty concept.

Successful response:

```json
{
  "roomId": "room-id",
  "roomCode": "AB7K2M",
  "playerId": "player-id",
  "role": "HOST",
  "participantToken": "<opaque-temporary-token>",
  "questionTimeLimitSeconds": 30
}
```

The frontend obtains the WebSocket URL from public runtime configuration, not from a secret.

---

## 7. Join flow

The participant flow is:

```text
Open Multiplayer
    ↓
Enter roomCode
    ↓
Select existing Player
    ↓
POST join
    ↓
Receive temporary participant token
    ↓
Open WebSocket
    ↓
IDENTIFY
    ↓
Receive current ROOM_STATE
```

Recommended HTTP operation:

```http
POST /multiplayer/rooms/{roomCode}/join
```

Request:

```json
{
  "playerId": "player-id"
}
```

Successful response:

```json
{
  "roomId": "room-id",
  "roomCode": "AB7K2M",
  "playerId": "player-id",
  "role": "PLAYER",
  "participantToken": "<opaque-temporary-token>"
}
```

The backend MUST reject:

- unknown room codes;
- expired rooms;
- rooms that are no longer in `WAITING`;
- duplicate room membership for a different active device unless treated as a reconnect;
- capacity overflow.

---

## 8. Temporary room membership token

Because v0.9 does not introduce Cognito or user accounts, room membership uses an opaque temporary capability token.

Requirements:

- generated by the backend;
- cryptographically random;
- at least 128 bits of entropy;
- scoped to one room and one player;
- expires with the room;
- never used as a permanent user identity;
- never stored in plaintext by the backend;
- backend stores only a cryptographic hash;
- MUST NOT be logged;
- MUST NOT appear in analytics events;
- MUST NOT be embedded in the room code.

The browser SHOULD keep the token in `sessionStorage` so a page refresh can reconnect without turning the token into long-lived application persistence.

The token SHOULD be sent in the first WebSocket identification message rather than in the WebSocket URL query string.

---

## 9. WebSocket lifecycle

### 9.1 Connection

`$connect` establishes the WebSocket transport.

A newly connected socket is initially unbound.

The client MUST identify itself before sending gameplay commands.

Example:

```json
{
  "action": "IDENTIFY",
  "roomCode": "AB7K2M",
  "playerId": "player-id",
  "participantToken": "<opaque-temporary-token>"
}
```

Only after successful validation may the backend bind:

```text
connectionId → roomId + playerId
```

### 9.2 Disconnect

`$disconnect` is treated as best-effort.

The application MUST NOT assume that every stale connection produces a reliable disconnect event.

Stale connections MUST also be cleaned up when a WebSocket callback fails because the connection no longer exists and through DynamoDB TTL.

### 9.3 Reconnect

An existing room member MAY reconnect using the same room membership token while it remains valid.

For v0.9, the most recently validated connection for a player SHOULD replace the previous connection.

A reconnect MUST NOT reset:

- score;
- previous answers;
- role;
- room membership;
- question progress.

Accepted limitation: multiplayer reconnection is supported while the ephemeral participant token remains available in the browser session (`sessionStorage`). If the browser/PWA session is fully terminated and the token is lost, the participant cannot securely reclaim the existing membership in v0.9 because player profiles are not authenticated identities. v0.9 MUST NOT add recovery based only on `roomCode + playerId`, token recovery, persistent token storage (`localStorage`, IndexedDB, persistent cookies), Cognito or login.

---

## 10. WebSocket client commands

The v0.9 protocol SHOULD use:

```text
action
requestId
payload
```

Recommended client → server actions:

```text
IDENTIFY
START_GAME
SUBMIT_ANSWER
QUESTION_TIMEOUT
NEXT_QUESTION
SYNC_ROOM
```

`requestId` SHOULD be unique per client command where an acknowledgement is expected.

The backend MUST validate every command against:

- room membership;
- player role when applicable;
- room state;
- question state;
- current question identity;
- deadline;
- duplicate processing rules.

---

## 11. WebSocket server events

Recommended server → client events:

```text
ROOM_STATE
PLAYER_JOINED
PLAYER_DISCONNECTED
GAME_STARTED
QUESTION_OPENED
ANSWER_ACCEPTED
QUESTION_REVEALED
SCOREBOARD_UPDATED
GAME_FINISHED
ERROR
```

All events SHOULD include:

```text
type
roomId
serverTime
```

State-changing events SHOULD additionally include a monotonically increasing room `version`.

Clients MUST treat backend state as authoritative and MUST NOT merge state based only on local assumptions.

---

## 12. Lobby behavior

While the room is `WAITING`:

- every member sees the room code;
- every member sees the joined players;
- the host is visually identified;
- only the host can start;
- the game cannot start with fewer than two players;
- new players can join until capacity is reached;
- no correct answers are exposed.

The lobby SHOULD update in real time when players join or reconnect.

---

## 13. Starting the game

Only the host may send:

```text
START_GAME
```

The backend MUST verify:

```text
role == HOST
room.status == WAITING
playerCount >= 2
game exists
```

The transition from `WAITING` to `IN_PROGRESS` MUST be atomic/idempotent.

The backend then opens question 1.

---

## 14. Question synchronization

For every question the backend defines:

```text
questionId
questionNumber
questionStartedAt
questionDeadlineAt
```

Default v0.9 time limit:

```text
30 seconds
```

The time limit SHOULD be configurable per room within a bounded supported range.

Recommended range:

```text
10–120 seconds
```

The backend's timestamp is authoritative.

The client countdown is presentation only.

`QUESTION_OPENED` MUST NOT include:

- `isCorrect`;
- the correct answer id;
- hidden validation metadata.

It MAY include existing question media information and identifiers needed to request the existing audio endpoint.

---

## 15. Answer submission

Client command:

```json
{
  "action": "SUBMIT_ANSWER",
  "requestId": "uuid",
  "payload": {
    "questionId": "question-id",
    "answerId": "answer-id"
  }
}
```

Requirements:

1. Only one accepted answer per player per question.
2. The first valid submission wins.
3. Duplicate/retried submissions MUST NOT create duplicate points.
4. The backend records its own receive timestamp.
5. A client-supplied response timestamp MUST NOT determine placement.
6. Answers received after the authoritative deadline MUST be rejected.
7. Correctness MUST be evaluated only by the backend from trusted game data.
8. The client receives an acknowledgement without learning correctness before reveal.

Recommended answer record:

```text
roomId
questionId
playerId
answerId
serverReceivedAtMs
responseDurationMs
isCorrect
```

`isCorrect` is internal until reveal.

---

## 16. Question completion

A question becomes eligible for reveal when either:

```text
all currently eligible room players have answered
OR
serverNow >= questionDeadlineAt
```

### 16.1 All players answered

The backend that accepts the final required answer SHOULD attempt the atomic transition:

```text
OPEN → REVEALED
```

### 16.2 Timeout

Clients render their countdown from server timestamps.

When the server-estimated time reaches the deadline, every connected client automatically sends (no user action):

```text
QUESTION_TIMEOUT
```

Each connection sends it once per question, with a bounded re-send while the question stays `OPEN`. This command is only a trigger.

The backend MUST independently verify:

```text
serverNow >= questionDeadlineAt
```

before revealing.

Multiple clients may send the timeout command. The reveal transition MUST remain idempotent so scoring occurs exactly once.

This approach avoids adding a scheduler solely for v0.9 while keeping the decision to close the question on the backend.

An early `QUESTION_TIMEOUT` (`serverNow < questionDeadlineAt`) is rejected: the question stays `OPEN` and nothing is scored.

### 16.3 Recovery of an overdue question

If a question is still `OPEN` after its deadline, the next backend activity for the room MUST close it through the same atomic reveal/scoring path. In v0.9 that activity is `IDENTIFY` (connect/reconnect), `SYNC_ROOM`, `SUBMIT_ANSWER`, `QUESTION_TIMEOUT` or `NEXT_QUESTION`. Concurrent recoveries still produce exactly one `OPEN → REVEALED` transition and one scoring finalization.

### 16.4 Accepted limitation

API Gateway WebSocket and Lambda are event-driven. If every connected client disappears and no backend invocation occurs after the deadline, the question cannot transition from OPEN to REVEALED until new activity reaches the backend. v0.9 does not add EventBridge Scheduler, Step Functions, cron, new Lambdas or backend polling for this.

---

## 17. Scoring model

### 17.1 Goals

The scoring model MUST:

- reward correct answers;
- reward faster correct answers;
- never reward a fast incorrect answer;
- allow first/second/third response placement to affect the podium;
- preserve educational correctness as the primary final-ranking criterion;
- be deterministic and calculated only by the backend.

### 17.2 Correctness points

For every correct answer:

```text
BASE_CORRECT_POINTS = 1000
```

Incorrect or unanswered:

```text
0 points
```

### 17.3 Placement

Placement is calculated only among players who answered correctly.

Correct answers are ordered by:

```text
serverReceivedAtMs ASC
```

Recommended speed bonus:

| Correct-answer placement | Speed bonus |
|---:|---:|
| 1st | 300 |
| 2nd | 200 |
| 3rd | 100 |
| 4th or later | 0 |

Therefore:

```text
QUESTION_POINTS =
    isCorrect
      ? BASE_CORRECT_POINTS + SPEED_BONUS(correctPlacement)
      : 0
```

Examples:

```text
1st correct answer  = 1300
2nd correct answer  = 1200
3rd correct answer  = 1100
4th+ correct answer = 1000
incorrect            = 0
timeout/no answer     = 0
```

A player who answers first but incorrectly does not consume "1st correct" placement. The first correct answer receives first-place speed bonus.

### 17.4 Near-simultaneous answers

Network latency makes exact device-side timing untrustworthy.

The backend SHOULD use server receive time and MAY apply a small tie window:

```text
PLACEMENT_TIE_WINDOW_MS = 100
```

Correct answers received within the same tie window share the same placement and bonus. The window is anchored on the first correct answer of each group.

Placement uses competition ranking: tied players share the placement, and the following player skips the shared places (`1, 1, 3`). Example: A and B answer correctly within 100 ms of each other, so both get placement 1 (1300 points), and the next correct answer C gets placement 3 (1100 points).

No client clock is trusted for scoring.

---

## 18. Final winner formula

The final podium MUST be deterministic.

For every player calculate:

```text
correctAnswers
totalPoints
firstPlaceCorrectAnswers
secondPlaceCorrectAnswers
thirdPlaceCorrectAnswers
cumulativeCorrectResponseTimeMs
```

The final ranking comparator is:

```text
1. correctAnswers                    DESC
2. totalPoints                       DESC
3. firstPlaceCorrectAnswers          DESC
4. secondPlaceCorrectAnswers         DESC
5. thirdPlaceCorrectAnswers          DESC
6. cumulativeCorrectResponseTimeMs   ASC
```

This means:

- correctness decides the winner first;
- among equally accurate players, speed bonuses decide the podium;
- first-place finishes are the next tie-breaker;
- total correct response time resolves extremely close ties.

This prevents a player with fewer correct answers from winning only because they guessed faster, while still making first/second/third response order meaningful throughout the game.

If all ranking fields are identical, the result MAY be declared a tie.

---

## 19. Reveal event

When the question is closed, the backend calculates placements and points exactly once.

`QUESTION_REVEALED` MAY include:

```json
{
  "type": "QUESTION_REVEALED",
  "roomId": "room-id",
  "questionId": "question-id",
  "correctAnswerId": "answer-id",
  "results": [
    {
      "playerId": "player-id",
      "isCorrect": true,
      "placement": 1,
      "pointsAwarded": 1300
    }
  ],
  "scoreboard": []
}
```

No correctness information may be broadcast before this transition.

---

## 20. Scoreboard and podium

After each reveal, every connected player sees the same authoritative scoreboard.

Recommended scoreboard fields:

```text
playerId
displayName
correctAnswers
totalPoints
firstPlaceCorrectAnswers
secondPlaceCorrectAnswers
thirdPlaceCorrectAnswers
rank
```

The live podium MUST use the same ranking comparator as the final result.

The UI SHOULD emphasize at least:

```text
1st
2nd
3rd
```

---

## 21. Next question

After a question is `REVEALED`, only the host may send:

```text
NEXT_QUESTION
```

The backend MUST reject `NEXT_QUESTION` while the current question is still `OPEN`.

The backend opens the next question and broadcasts `QUESTION_OPENED`.

After the last question, `NEXT_QUESTION` is not required. Revealing the last question sets `room.status = FINISHED` in the same atomic transition (`OPEN → REVEALED` plus `FINISHED`), then the backend broadcasts `QUESTION_REVEALED`, `SCOREBOARD_UPDATED` and `GAME_FINISHED`. `NEXT_QUESTION` on a finished room is rejected.

---

## 22. Data consistency

The backend MUST prevent:

- duplicate room creation for the same generated room code;
- duplicate room membership;
- duplicate answers;
- double scoring;
- double reveal;
- starting an already-started room;
- advancing an open question;
- answering a previous/future question;
- scoring after room completion.

DynamoDB conditional writes and/or transactions SHOULD enforce invariants where concurrency matters.

---

## 23. Persistence requirements

v0.9 introduces one dedicated DynamoDB table for ephemeral multiplayer coordination.

Recommended logical records:

```text
ROOM
PLAYER_MEMBERSHIP
ANSWER
CONNECTION
```

The new table MUST NOT replace:

```text
Games
GameSessions
Players
```

Existing single-player `GameSessions` remain unchanged.

Multiplayer state SHOULD use TTL because rooms and WebSocket connections are temporary.

---

## 24. Security requirements

v0.9 MUST:

- use HTTPS/WSS only;
- preserve existing CORS/origin rules for HTTP;
- validate the WebSocket `Origin` during connection against configured allowed frontend origins;
- never expose AWS credentials;
- never expose Bedrock credentials;
- never expose S3 private-object credentials;
- never log participant tokens;
- never trust `playerId`, room role, timestamps, score, placement, or correctness sent by a client;
- validate room membership for every gameplay command;
- use least-privilege IAM for WebSocket callbacks.

The room code alone MUST NOT authorize host/gameplay operations.

---

## 25. Failure behavior

The system SHOULD handle:

### Invalid/expired room

Return a safe domain error.

### Invalid participant token

Reject identification and do not bind the connection.

### Stale WebSocket connection

Remove/expire the connection mapping and continue broadcasting to remaining players.

### Player disconnects during a question

The player's existing answer remains valid.

For v0.9, a disconnected existing member remains a room member and may reconnect.

Question completion SHOULD use the eligible player set defined when the question opened so disconnecting does not create a scoring exploit.

### Backend retry / duplicate message

State transitions and scoring remain idempotent.

---

## 26. Observability

Structured logs SHOULD include safe identifiers:

```text
correlationId
roomId
roomCodeHash
connectionIdHash
action
questionId
roomStatus
questionState
durationMs
result
```

Logs MUST NOT include:

```text
participantToken
participantTokenHash
player name
raw answer text
correct answer content
AWS credentials
```

Recommended metrics/events:

```text
MULTIPLAYER_ROOM_CREATED
MULTIPLAYER_PLAYER_JOINED
MULTIPLAYER_CONNECTED
MULTIPLAYER_RECONNECTED
MULTIPLAYER_GAME_STARTED
MULTIPLAYER_ANSWER_ACCEPTED
MULTIPLAYER_QUESTION_REVEALED
MULTIPLAYER_GAME_FINISHED
MULTIPLAYER_PROTOCOL_REJECTED
MULTIPLAYER_BROADCAST_STALE_CONNECTION
```

---

## 27. Frontend requirements

Add a simple multiplayer path to the PWA.

Recommended flow:

```text
Home
 └─ Multiplayer
      ├─ Create room
      │    ├─ Select player
      │    ├─ Select game
      │    └─ Lobby
      │
      └─ Join room
           ├─ Enter code
           ├─ Select player
           └─ Lobby
```

Gameplay screens SHOULD reuse existing question presentation components where practical.

Multiplayer-specific presentation adds:

- room code;
- connected players;
- host badge;
- countdown;
- answer locked state after submission;
- reveal;
- awarded points;
- live podium;
- final podium.

The frontend MUST NOT duplicate scoring logic as a source of truth. It may reproduce calculations only for display/testing, but the backend result wins.

---

## 28. Compatibility requirements

v0.9 MUST NOT remove or rename existing public HTTP routes.

Existing single-player behavior must remain available.

Existing media behavior must remain compatible.

Existing game generation must remain compatible.

Existing `Player` profiles continue to be shared by single-player and multiplayer.

---

## 29. Testing requirements

### 29.1 Domain/Application tests

Cover at least:

- room-state transitions;
- minimum player requirement;
- host-only commands;
- room capacity;
- scoring for 1st/2nd/3rd/4th correct;
- incorrect fastest answer gets 0;
- placement among correct answers only;
- tie window;
- final ranking comparator;
- exact final tie;
- duplicate answer;
- answer after deadline;
- duplicate timeout;
- duplicate reveal;
- double-scoring prevention;
- reconnect preserving state.

### 29.2 HTTP contract tests

Cover:

- create room;
- join room;
- invalid room;
- expired room;
- room already started;
- duplicate player;
- capacity reached.

### 29.3 WebSocket tests

Cover:

- connect;
- identify;
- invalid token;
- non-identified command rejection;
- start game;
- submit answer;
- all-answered reveal;
- timeout reveal;
- scoreboard broadcast;
- next question;
- final game;
- stale connection;
- reconnect.

### 29.4 Infrastructure tests

CDK tests SHOULD verify:

- WebSocket API exists;
- required routes exist;
- same backend Lambda is integrated;
- multiplayer DynamoDB table exists;
- TTL is enabled;
- least-privilege `execute-api:ManageConnections` permission is granted;
- table permissions are scoped;
- outputs/config required by the frontend exist.

### 29.5 Standard validation

Before v0.9 is considered complete:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

---

## 30. Acceptance scenarios

### Scenario A — Normal multiplayer

1. Host creates room.
2. Second player joins from another device.
3. Host starts.
4. Both receive the same question.
5. Both answer.
6. Backend reveals.
7. Faster correct player receives higher speed bonus.
8. Both see the same scoreboard.
9. Host advances.
10. Final podium is identical on both devices.

### Scenario B — Fast incorrect answer

1. Player A answers first but incorrectly.
2. Player B answers later but correctly.
3. Player A receives 0.
4. Player B receives first-correct placement and 1300 points.

### Scenario C — Timeout

1. One player does not answer.
2. Deadline expires.
3. One or more clients send `QUESTION_TIMEOUT`.
4. Backend verifies the deadline.
5. Backend reveals exactly once.
6. Non-answering player receives 0.

### Scenario D — Simultaneous timeout commands

1. Several clients detect countdown completion.
2. All send `QUESTION_TIMEOUT`.
3. Only one atomic state transition closes the question.
4. Score is applied once.
5. All clients receive the same reveal.

### Scenario E — Reconnect

1. A player temporarily loses connectivity.
2. The player reconnects with the existing room membership token.
3. Score and membership are preserved.
4. The current room state is synchronized.

---

## 31. Definition of done

FASE 9 / v0.9 is complete when:

- multiplayer works across at least two physical devices;
- host/join flow works without Cognito/login;
- WebSocket real-time synchronization works;
- all clients receive consistent state;
- answers are server-authoritative;
- timeouts are server-validated;
- correct-answer speed affects points;
- final ranking follows the defined comparator;
- reconnect works;
- duplicate commands cannot duplicate scoring;
- single-player remains functional;
- standard validation passes;
- infrastructure is deployable with CDK;
- ADR-018, ADR-019, and ADR-020 are accepted and consistent with implementation.
