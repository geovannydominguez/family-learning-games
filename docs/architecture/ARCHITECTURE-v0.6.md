# Family Learning Games — Architecture v0.6

## 1. Purpose

v0.6 introduces persistent family player profiles and uses them as educational context for gameplay and AI-generated games.

This version evolves the existing architecture without replacing it.

The main architectural change is:

```text
Player
  ↓
persistent profile
  ↓
playerId
  ↓
Application resolves age
  ↓
GameGenerator receives targetAge
  ↓
Bedrock generates age-appropriate content
```

The version deliberately avoids introducing authentication, separate profile services, additional Lambdas or other infrastructure that is unnecessary for the current product scale.

---

# 2. Architecture evolution

Previous architecture:

```text
Browser
   │
   ▼
Next.js
   │
   ▼
GameApiClient
   │
   ▼
API Gateway HTTP API
   │
   ▼
Backend Lambda
   │
   ▼
Application
   │
   ├── GameRepository
   │        │
   │        ▼
   │     DynamoDB Games
   │
   ├── GameSessionRepository
   │        │
   │        ▼
   │     DynamoDB GameSessions
   │
   └── GameGenerator
            │
            ▼
     BedrockGameGenerator
            │
            ▼
       Amazon Bedrock
```

v0.6 becomes:

```text
Browser
   │
   ▼
Next.js
   │
   ▼
GameApiClient
   │
   ▼
API Gateway HTTP API
   │
   ▼
Backend Lambda
   │
   ▼
Application
   │
   ├── PlayerRepository
   │        │
   │        ▼
   │     DynamoDB Players
   │
   ├── GameRepository
   │        │
   │        ▼
   │     DynamoDB Games
   │
   ├── GameSessionRepository
   │        │
   │        ▼
   │     DynamoDB GameSessions
   │
   └── GameGenerator
            │
            ▼
     BedrockGameGenerator
            │
            ▼
       Amazon Bedrock
```

No additional backend runtime is introduced.

---

# 3. Player domain model

v0.6 promotes `Player` to a persistent domain concept.

Proposed model:

```ts
export interface Player {
  playerId: string;
  name: string;
  age: number;
  createdAt: string;
  updatedAt: string;
}
```

Important invariants:

```text
playerId != player name

age is explicit

player identity is application-owned

Player has no AWS dependencies
```

The domain object must not contain DynamoDB-specific attributes.

---

# 4. Persistence

Introduce:

```text
Players DynamoDB table
```

Primary key:

```text
PK = playerId
```

Example:

```text
Players
┌────────────────────┬──────────┬─────┬──────────────────────┐
│ playerId           │ name     │ age │ updatedAt            │
├────────────────────┼──────────┼─────┼──────────────────────┤
│ player-01...       │ Amelia   │ 4   │ 2026-09-11T...       │
│ player-02...       │ Joaquín  │ 6   │ 2026-09-11T...       │
└────────────────────┴──────────┴─────┴──────────────────────┘
```

The expected number of profiles is very small.

For this reason:

```text
GET /players
```

may use a DynamoDB Scan in v0.6.

Adding GSIs for this requirement would add complexity with no current product benefit.

---

# 5. Repository boundary

Application defines:

```ts
export interface PlayerRepository {
  list(): Promise<Player[]>;
  getById(playerId: string): Promise<Player | null>;
  create(player: Player): Promise<Player>;
  update(player: Player): Promise<Player>;
  delete(playerId: string): Promise<void>;
}
```

Infrastructure provides:

```text
DynamoDbPlayerRepository
```

Therefore:

```text
Application
      │
      ▼
PlayerRepository
      ▲
      │
DynamoDbPlayerRepository
```

Application and Domain do not know that DynamoDB exists.

---

# 6. Player management flow

Create:

```text
Next.js
  │
  │ POST /players
  ▼
API Gateway
  ▼
Backend Lambda
  ▼
CreatePlayer
  ▼
PlayerRepository
  ▼
DynamoDB Players
```

List:

```text
Next.js
  │
  │ GET /players
  ▼
API Gateway
  ▼
Backend Lambda
  ▼
ListPlayers
  ▼
PlayerRepository
  ▼
DynamoDB Players
```

Update and delete follow the same architecture.

---

# 7. Player-aware game generation

This is the most important integration introduced by v0.6.

Request:

```json
{
  "topic": "Pokémon",
  "difficulty": "easy",
  "questionCount": 10,
  "playerId": "player-123"
}
```

Architecture:

```text
POST /games/generate
       │
       ▼
GenerateGame
       │
       ├── playerId
       │
       ▼
PlayerRepository.getById()
       │
       ▼
Player
 age = 6
       │
       ▼
GenerateGameRequest
 targetAge = 6
       │
       ▼
GameGenerator
       │
       ▼
BedrockGameGenerator
       │
       ▼
Amazon Bedrock
```

The infrastructure AI adapter does not need access to the complete player object.

Only the educational context crosses the `GameGenerator` boundary.

Example:

```ts
const player = await playerRepository.getById(request.playerId);

const draft = await gameGenerator.generate({
  topic: request.topic,
  difficulty: request.difficulty,
  questionCount: request.questionCount,
  targetAge: player.age,
});
```

This is preferable to:

```ts
gameGenerator.generate({
  player
});
```

because the AI provider does not need the player's identity.

---

# 8. Privacy boundary

The AI boundary is intentionally restrictive.

Allowed AI context:

```text
topic
difficulty
questionCount
targetAge
```

Not allowed:

```text
playerId
player name
sessionId
family information
application identifiers
```

Architecture:

```text
Player
 ├─ playerId ─────X────> Bedrock
 ├─ name ─────────X────> Bedrock
 └─ age ──> targetAge ─> Bedrock
```

This applies data minimization at the application boundary.

---

# 9. Age and difficulty

`age` and `difficulty` represent different concepts.

Age answers:

```text
For whom is this game being generated?
```

Difficulty answers:

```text
How challenging should the game be relative to that player?
```

Therefore they must not be collapsed into a single value.

Example:

```text
Player age: 6

Easy:
basic concepts expected below or around the target age

Medium:
normal concepts appropriate to the target age

Hard:
more challenging concepts while still remaining suitable
for the target age
```

A hard game for a six-year-old must not become a game intended for teenagers.

The prompt and validator must preserve this distinction.

---

# 10. Existing AI validation pipeline

v0.6 must reuse the validation pipeline introduced in previous versions.

Conceptually:

```text
Generate
   │
   ▼
Generator model
   │
   ▼
Structured draft
   │
   ▼
Validator
   │
   ├── semantic validity
   ├── single correct answer
   ├── age suitability
   ├── question quality
   └── schema validity
   │
   ▼
Persist
```

Player profiles add context to this pipeline.

They do not bypass or replace validation.

Age appropriateness should be included in semantic validation when the validator supports it.

---

# 11. Game persistence

Generated games continue to be persisted in:

```text
Games
```

A generated game may optionally record the generation context necessary for traceability.

For example:

```ts
generationMetadata?: {
  targetAge?: number;
  difficulty?: Difficulty;
}
```

Do not persist the player's name in generated games.

Persisting `targetAge` is preferable to using the current age from the profile later because the player profile may change.

Whether `playerId` is stored on `Game` is not required for v0.6.

The game should remain reusable unless product requirements explicitly make games private to a player.

---

# 12. Game sessions

New sessions should associate gameplay with a player.

Example:

```ts
interface GameSession {
  sessionId: string;
  gameId: string;
  playerId?: string;
  ...
}
```

Flow:

```text
Selected Player
      │
      ▼
playerId
      │
      ▼
POST /game-sessions
      │
      ▼
GameSession
      │
      ▼
DynamoDB GameSessions
```

The optional type preserves compatibility with historical records.

The UI should use a player for new sessions.

---

# 13. Historical consistency

Player data is mutable.

Historical game/session data must not depend on mutable player properties.

Example:

```text
September:
Joaquín age = 6
game generated with targetAge = 6

Later:
profile age = 7
```

The old game remains:

```text
targetAge = 6
```

It is not regenerated or reinterpreted.

This distinction prevents profile updates from changing historical behavior.

---

# 14. Frontend architecture

Suggested frontend flow:

```text
Home
 │
 ▼
Player selection
 │
 ├── Amelia
 ├── Joaquín
 ├── Mamá
 ├── Papá
 └── + Add player
 │
 ▼
Game selection
 │
 ├── Existing game
 │
 └── Create game
       │
       ▼
      Topic
       │
       ▼
   Difficulty
       │
       ▼
    Generate
       │
       ▼
      Play
       │
       ▼
     Result
```

The active selection should carry:

```ts
playerId
```

rather than duplicating the complete profile throughout API requests.

---

# 15. AWS deployment architecture

v0.6 infrastructure:

```text
Route 53
   │
   ▼
play.joamgames.com
   │
   ▼
AWS Amplify Hosting
   │
   ▼
Next.js
   │
   ▼
API Gateway HTTP API
   │
   ▼
Backend Lambda
   │
   ├───────────────┬──────────────────┬───────────────────┐
   ▼               ▼                  ▼                   ▼
Players          Games          GameSessions          Bedrock
DynamoDB        DynamoDB          DynamoDB
```

The deployment continues to use the infrastructure already established by the project.

---

# 16. CDK changes

The backend stack should add:

```text
PlayersTable
```

and expose its name to the Lambda:

```text
PLAYERS_TABLE_NAME
```

The Lambda requires permissions for the minimum necessary operations.

Conceptually:

```text
dynamodb:GetItem
dynamodb:PutItem
dynamodb:UpdateItem
dynamodb:DeleteItem
dynamodb:Scan
```

No broad DynamoDB wildcard permission should be introduced.

Stack output may include:

```text
PlayersTableName
```

---

# 17. API surface

v0.6 adds:

```text
GET    /players
POST   /players
PUT    /players/{playerId}
DELETE /players/{playerId}
```

Existing routes remain:

```text
GET  /game-setup
POST /game-sessions
GET  /game-sessions/{id}
POST /games/generate
...
```

The architecture remains a single HTTP API.

---

# 18. Compatibility

v0.6 must remain compatible with data generated by earlier versions.

Specifically:

```text
Games without targetAge              → valid
GameSessions without playerId        → valid
Players                              → new
New sessions with playerId           → valid
Generated games with targetAge       → valid
```

No destructive DynamoDB migration is required.

---

# 19. Architecture boundaries

The project must continue to enforce:

```text
Domain
  ↑
Application
  ↑
Infrastructure
  ↑
Entrypoints / UI
```

Dependencies must point inward.

Incorrect:

```text
Domain → DynamoDB
Application → AWS SDK
Application → Bedrock SDK
```

Correct:

```text
Application → PlayerRepository
Infrastructure → DynamoDB

Application → GameGenerator
Infrastructure → Bedrock
```

---

# 20. Explicit non-goals

v0.6 does not introduce:

```text
Cognito
authentication
authorization by player
multiple family accounts
profile passwords
profile PINs
avatars stored in S3
PWA
offline mode
audio
question images
multiplayer
WebSockets
leaderboards
achievements
learning analytics
```

These would materially expand the architecture and belong to later phases.

---

# 21. Target state

At the end of v0.6:

```text
Family
  │
  ▼
Persistent Player Profiles
  │
  ├──────> Game Sessions
  │
  └──────> Age Context
                │
                ▼
        AI Game Generation
                │
                ▼
        Age-appropriate Game
```

The central architectural outcome is not merely storing players.

It is establishing a clean boundary between:

```text
player identity
```

and:

```text
educational personalization context
```

so future phases can build on profiles without coupling the AI layer to personal information.
