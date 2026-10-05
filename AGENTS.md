# Family Learning Games — AGENTS.md

## Current target
> **v0.9 — Multiplayer**

## Current roadmap phase
> **FASE 9 — Multiplayer**
>
> Builds incrementally on the v0.8.0 baseline (FASE 8 — Audio / imágenes, completed).

## Mandatory documentation
Before modifying v0.9 code, read:

1. `AGENTS.md`
2. `docs/architecture/REQUIREMENTS-v0.9.md`
3. `docs/architecture/ARCHITECTURE-v0.9.md`
4. `docs/architecture/ADR-018-api-gateway-websocket-multiplayer.md`
5. `docs/architecture/ADR-019-server-authoritative-multiplayer-state.md`
6. `docs/architecture/ADR-020-multiplayer-room-membership-and-ephemeral-tokens.md`

Then, when touching the areas they cover, the v0.8 and earlier baseline documents:

1. `docs/architecture/ARCHITECTURE-V0.8.md`
3. `docs/architecture/REQUIREMENTS-V0.8.md`
4. `docs/architecture/ADR-016-game-media-assets-private-s3.md`
5. `docs/architecture/ADR-017-amazon-polly-question-audio.md`
6. `docs/architecture/ARCHITECTURE-v0.7.1.md`
7. `docs/architecture/REQUIREMENTS-v0.7.1.md`
8. `docs/architecture/ADR-015-claude-sonnet-ai-generation-quality.md`
9. `docs/architecture/ADR-014-pwa-online-first.md`
10. `docs/architecture/ARCHITECTURE-v0.7.md` and `docs/architecture/REQUIREMENTS-v0.7.md`
11. ADR-009, ADR-011, ADR-012 and ADR-013 when touching AI generation, game identity, players, or AI personalization.

Previous accepted architecture/ADRs remain relevant unless superseded. In particular:

- `ADR-009-ai-game-validation-and-identity.md` remains the accepted decision for AI-generated game validation and identity.
- `ADR-010.md` is the only ADR that decides AWS Amplify Hosting for the public frontend.
- `ADR-011-two-model-ai-generation-pipeline.md` decides the two-model AI generation pipeline.
- `ADR-012.md` decides persistent family player profiles.
- `ADR-013.md` decides age-aware AI personalization derived from player profiles.
- `ADR-014-pwa-online-first.md` decides the online-first PWA with controlled static caching.
- `ADR-015-claude-sonnet-ai-generation-quality.md` evolves the ADR-011 AI pipeline implementation for v0.7.1: Claude Sonnet 4.6, stronger difficulty/diversity requirements, answer-order verification, bounded observability, and synchronous execution-budget awareness.
- `ADR-016-game-media-assets-private-s3.md` decides one private S3 media bucket (`images/`, `audio-cache/`), logical image references in the Domain, and short-lived signed read URLs.
- `ADR-017-amazon-polly-question-audio.md` decides on-demand Amazon Polly question audio behind a `SpeechSynthesizer` port, derived server-side from persisted games, cached in S3.
- `ADR-018-api-gateway-websocket-multiplayer.md` decides one API Gateway WebSocket API for multiplayer, integrated with the same backend Lambda; the HTTP API keeps room bootstrap.
- `ADR-019-server-authoritative-multiplayer-state.md` decides server-authoritative multiplayer state, scoring and ranking in one dedicated TTL-backed DynamoDB table, with conditional writes/transactions for every concurrent transition.
- `ADR-020-multiplayer-room-membership-and-ephemeral-tokens.md` decides room membership through a short room code plus an opaque, hashed, room-scoped `participantToken` (no Cognito/login).

## Architecture

```text
GitHub
   ↓
AWS Amplify Hosting (Route 53 → play.joamgames.com)
   ↓
Browser / Installed PWA
   ├── Manifest + icons
   └── Service Worker ──► Cache Storage (static assets + offline fallback only)
   ↓
Next.js
   ├── GameApiClient ──────────► API Gateway HTTP API ─────────────┐   (NETWORK ONLY)
   └── MultiplayerSocketClient ─► API Gateway WebSocket API (v0.9) ─┤   (WSS, online only)
                                                                    ↓
AWS Lambda family-learning-games-backend (HTTP router + WebSocket router)
   ↓
Application
   ├── GameGenerator / GameValidator ──► Bedrock adapters ──► Amazon Bedrock
   ├── QuestionSpeechService ──► SpeechSynthesizer port ──► PollySpeechSynthesizer ──► Amazon Polly
   │                         └─► MediaObjectStore port ──► S3MediaObjectStore ──► private S3 (audio-cache/)
   ├── QuestionImageResolver (controlled catalog) ──► MediaObjectStore ──► private S3 (images/)
   ├── MultiplayerRoomService / MultiplayerGameplayService (v0.9)
   │     ├─► MultiplayerRepository port ──► DynamoDbMultiplayerRepository ──► DynamoDB Multiplayer table (TTL)
   │     └─► MultiplayerBroadcaster port ──► ApiGatewayWebSocketBroadcaster ──► postToConnection
   └── Repository ports (Game, GameSession, Player) ──► DynamoDB repositories ──► DynamoDB
   ↓
Domain (game, player, multiplayer)
```

## Mandatory rules

### Domain is AWS-independent
No AWS SDK, Amplify, Bedrock, Lambda, API Gateway, DynamoDB, or CDK imports in Domain.

### Application is provider-independent
Application depends on `GameGenerator`, never directly on Bedrock SDK types.

### Frontend hosting is presentation-only infrastructure
AWS Amplify Hosting only builds and serves the Next.js frontend. It never becomes a second backend, never receives AWS credentials, and never bypasses `GameApiClient`.

### One backend Lambda
Reuse the existing `family-learning-games-backend` Lambda and its HTTP API. Do not create a second Lambda or a separate API to serve the frontend. Since v0.9 the same Lambda also serves the multiplayer WebSocket API (ADR-018); the handler distinguishes WebSocket events (`requestContext.connectionId`) from HTTP API v2 events. Do not add dedicated WebSocket Lambdas.

### Never trust model output
AI-produced data is untrusted. Validate deeply before persistence.

### One game domain
Seeded and generated games use the same `Game` and `GameSession`.

### Players are a persisted domain entity
`Player` (`playerId`, `name`, `age`, `createdAt`, `updatedAt`) is persisted through the `PlayerRepository` port and served by the existing backend Lambda. Players are family profiles, not user accounts: no authentication or authorization is attached to them.

### AI personalization uses data minimization
When a generation request carries `playerId`, Application resolves the player through `PlayerRepository` and derives `targetAge`. The AI boundary (`GameGenerator`, validator, Bedrock adapters) receives only `targetAge`; never `playerId`, player name, `sessionId`, or family metadata. The frontend must not send authoritative age when a `playerId` exists. `difficulty` remains independent from `targetAge`.

### PWA is presentation-only and online-first
The manifest, icons, Service Worker, and offline fallback belong exclusively to the frontend/browser layer. The Service Worker must not contain game, player, AI, or session rules, must never cache backend/API responses as application state, and must only delete caches it owns (`joam-static-*`). DynamoDB remains the only source of truth. Offline fallback is supported; offline gameplay is not. ADR-014 remains authoritative and unchanged: v0.7.1 must preserve the installable online-first PWA behavior and must not introduce offline gameplay or API/AI response caching.

### Media is optional, controlled, and private (v0.8)
- Audio is synthesized **on demand** only by `POST /games/{gameId}/questions/{questionId}/audio`. The endpoint accepts identifiers only (any body field such as `text`, `ssml`, `voiceId` is rejected); the backend builds plain text from the persisted question and its options in displayed order. Speech never includes `isCorrect`, IDs, player data, or SSML.
- Audio is never synthesized during game generation or session flows, and never consumes or alters the v0.7.1 Generator/Validator execution budget.
- Audio cache keys are opaque (`audio-cache/<version>/<sha256>.mp3`) and change with text, language, voice profile or `AUDIO_CACHE_VERSION`.
- Domain stores only `Question.media.image = { assetId, altText }`. Never persist S3 URLs, bucket names, object keys, or signed URLs. Public question DTOs expose it additively as `media: { image: { url, altText } }` with a short-lived signed URL. The legacy public `image?: string` field (since v0.2) keeps its type and pass-through behavior; never reuse or retype it.
- Images come only from the controlled catalog (`src/data/mediaCatalog.json`). No AI image generation, external URLs, uploads, or family photos. The AI Generator must not produce media. A missing/failed image degrades to text-only.
- The media bucket stays private (block public access, ACLs disabled, encryption, TLS-only). Never make it public or add a website/CDN in front of it.
- Media failures must never block answering, advancing, or completing a game.
- Polly and S3 SDKs live only in Infrastructure (`src/infrastructure/media/`).
- Speech uses one fixed profile in v0.8: `Lupe` / `neural` / `es-US` / `mp3` (`Opción N` labels). Do not add i18n, language selection or voice mapping.
- The audio endpoint reuses the existing HTTP contract (endpoint-specific success body, `{ "error": { code, message } }` errors); never add a second envelope.
- The media bucket uses `DESTROY` + `autoDeleteObjects` in the default `dev` environment and `RETAIN` for `environment=prod|production`. The CDK auto-delete handler is a deploy-time helper, not an application Lambda.
- Concurrent cache-miss double synthesis is an accepted limitation; do not add locks, queues or idempotency tables for it.

### Multiplayer is server-authoritative and ephemeral (v0.9)
- The backend alone decides room/question state, `questionStartedAt`/`questionDeadlineAt`, answer acceptance and server receive time, correctness, placement, points, scoreboard and rank. Clients send intents only; never trust client role, score, correctness, placement, timestamps, deadline or current question.
- Room `WAITING → IN_PROGRESS → FINISHED` (`EXPIRED` is derived from `expiresAt`); question `NOT_STARTED → OPEN → REVEALED`. Every concurrent transition is a DynamoDB conditional write or transaction and must stay idempotent: one room-code reservation, one membership per room/player, one answer per room/question/player, one start, one `OPEN → REVEALED` with scoring in the same transaction. Duplicate WebSocket messages are normal.
- A question closes when every player in its eligible set (fixed when it opens) answered, or `serverNow >= questionDeadlineAt`. `QUESTION_TIMEOUT` is only a trigger, sent automatically by the client (`questionTimeoutToSend`) when its server-estimated time reaches the deadline. An overdue `OPEN` question is recovered by the next `IDENTIFY`, `SYNC_ROOM`, `SUBMIT_ANSWER`, `QUESTION_TIMEOUT` or `NEXT_QUESTION` through the single reveal path (`revealIfClosable`); never duplicate reveal/scoring logic. Accepted limitation: with no backend activity after the deadline, the question stays `OPEN` until activity resumes. Do not add EventBridge Scheduler, Step Functions, cron, polling or queues for timing. Disconnecting never shrinks the eligible set.
- Revealing the last question sets `FINISHED` atomically and sends `GAME_FINISHED`; there is no `NEXT_QUESTION` after the final question.
- Scoring: correct = `1000 + 300/200/100/0` by server receive order among correct answers only (100 ms tie window, competition ranking `1, 1, 3` with a shared bonus); incorrect/no answer = 0. One comparator (`src/domain/multiplayer/scoring.ts`) for live scoreboard, live podium and final podium: correct answers ↓, points ↓, 1st/2nd/3rd places ↓, cumulative correct response time ↑. The frontend never recomputes rank or score.
- `isCorrect` / `correctAnswerId` are never sent before `REVEALED` (not in `QUESTION_OPENED`, `ANSWER_ACCEPTED`, `ROOM_STATE` or HTTP responses).
- Membership: no Cognito/login/JWT. Create/join return a `participantToken` (≥128-bit random) once; persist only its SHA-256, compare in constant time, never log it or its hash, never broadcast it. It is sent only in the first `IDENTIFY` message (never in the WebSocket URL). The browser keeps it in `sessionStorage` only (never `localStorage`/IndexedDB). The latest identified connection of a member wins. The room code is an identifier, not a secret. Accepted limitation: if the browser session ends and the token is lost, the membership cannot be reclaimed. Never add recovery by `roomCode + playerId`, token recovery or persistent token storage.
- `POST /multiplayer/rooms` accepts an optional `difficulty` (existing `Difficulty` enum) to choose which questions a seeded game plays; omitted means the game's first difficulty.
- `$connect` validates `Origin` against the same configured `allowedOrigins`; it never replaces the token.
- One dedicated multiplayer table (PK/SK, TTL on `expiresAt`); room codes resolve through a `CODE#<code>/RESERVATION` item, never a scan. TTL is cleanup only: Application checks `serverNow < expiresAt`. Never store multiplayer state in `GameSessions`.
- Broadcasts go through the `MultiplayerBroadcaster` port; API Gateway Management API code lives only in `src/infrastructure/multiplayer/`. A `GoneException` releases the stale mapping and never fails delivery to others. Lambda gets `execute-api:ManageConnections` on `<ws-api>/production/POST/@connections/*` only.
- Logs carry opaque IDs, hashes (`roomCodeHash`, `connectionIdHash`), states and durations; never tokens/hashes, player names, answer text or correct-answer content.
- Multiplayer is online only: the Service Worker never caches WebSocket traffic, room state or tokens.

## Identity rule
`gameId = categoryId` is no longer a domain invariant. Existing seeded IDs remain valid. Generated games use unique IDs created by Application through an injected ID factory.

## Frontend configuration
The backend base URL remains external configuration, never hardcoded:

```text
NEXT_PUBLIC_GAME_API_BASE_URL
```

Components, hooks, use cases, and adapters must read it through the existing `GameApiClient` configuration path. Do not hardcode an API Gateway URL in application code.

## CORS / allowed origins
The API Gateway HTTP API accepts a configurable list of allowed origins so both local development and the public Amplify frontend can call it:

```text
allowedOrigins   # CDK context, comma-separated list, takes precedence
frontendOrigin   # CDK context, single origin, backward-compatible fallback
```

Default is `http://localhost:3000` when neither is supplied. Do not remove local development support. Do not hardcode a specific Amplify-generated domain or the production domain in code; pass them through `allowedOrigins` at deploy time instead (for example `http://localhost:3000,https://play.joamgames.com`). Never set an allowed origin to `*`.

## Deployment model
Frontend deployment flows from GitHub through AWS Amplify Hosting:

```text
git push → GitHub → Amplify build/deploy → https://play.joamgames.com
```

The canonical production URL is `https://play.joamgames.com` (Route 53 custom domain attached to the Amplify app in the AWS Console). PWA files (`public/sw.js`, `public/offline.html`, `public/icons/`, `src/app/manifest.ts`) ship inside the same frontend artifact; `amplify.yml` only adds revalidation headers for `/sw.js` and `/manifest.webmanifest`.

Do not introduce GitHub Actions, CodePipeline, CodeBuild, Jenkins, ArgoCD, or Terraform. Amplify's own GitHub integration handles checkout, install, build, and deploy. Connecting the GitHub repository to an Amplify app and attaching the custom domain are interactive, account-owner actions performed in the AWS Console; they are not automated by CDK.

## Circular CORS/Amplify dependency
Applies when (re)creating the environment from scratch. The Amplify public origin is only known after the Amplify app exists, but the backend must allow that origin. Resolve this explicitly, never by opening CORS with `*`:

```text
1. Deploy the backend (default/localhost-only CORS is fine initially).
2. Create the Amplify app connected to GitHub and let it build once.
3. Read the generated Amplify domain and attach the custom domain (play.joamgames.com) in the Amplify Console.
4. Redeploy the backend with allowedOrigins including localhost and the public origin(s).
5. Set NEXT_PUBLIC_GAME_API_BASE_URL in Amplify and redeploy the frontend.
6. Validate the public flow end to end.
```

## Configuration
Do not hardcode models, Guardrails, or origins in Domain/Application.

Use configuration such as:

```text
AI_GAME_GENERATION_ENABLED
BEDROCK_GENERATOR_MODEL_ID   # global.anthropic.claude-sonnet-4-6
BEDROCK_VALIDATOR_MODEL_ID   # global.anthropic.claude-sonnet-4-6
BEDROCK_REGION
BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
MEDIA_BUCKET_NAME            # v0.8, set by CDK; media is disabled when absent
MULTIPLAYER_TABLE_NAME       # v0.9, set by CDK; multiplayer is disabled when absent
MULTIPLAYER_MAX_PLAYERS      # default 8 (CDK context multiplayerMaxPlayers, 2..8)
MULTIPLAYER_ROOM_TTL_MINUTES # default 120
MULTIPLAYER_PLACEMENT_TIE_WINDOW_MS # default 100
MULTIPLAYER_ALLOWED_ORIGINS  # set by CDK from allowedOrigins (WebSocket $connect Origin check)
WEBSOCKET_CALLBACK_ENDPOINT  # set by CDK: WebSocket stage callback URL for postToConnection
POLLY_VOICE_ID               # fixed: Lupe   (v0.8 single speech profile, set by CDK)
POLLY_ENGINE                 # fixed: neural
POLLY_LANGUAGE_CODE          # fixed: es-US
POLLY_OUTPUT_FORMAT          # fixed: mp3
AUDIO_URL_TTL_SECONDS        # default 900
IMAGE_URL_TTL_SECONDS        # default 900
AUDIO_CACHE_VERSION          # default v1
NEXT_PUBLIC_GAME_API_BASE_URL
NEXT_PUBLIC_MULTIPLAYER_WEBSOCKET_URL   # v0.9, public WSS URL (MultiplayerWebSocketUrl output); not a secret
```

AI generation defaults to disabled. Bedrock generator/validator models, region, and Guardrail configuration are required only when it is enabled. The model IDs remain configuration and must not be hardcoded in Domain/Application.

`ADR-011` continues to define the independent Generator/Validator pipeline and deterministic Application validation. `ADR-015` defines the v0.7.1 model/configuration and quality evolution.

## Persistence
Use the existing `Games`, `GameSessions`, and `Players` tables (`Players`: PK = `playerId`, no secondary indexes). Do not introduce RDS, Aurora, S3-as-database, Redis, or ElastiCache. The Service Worker cache and browser storage are not application persistence. The v0.8 media bucket stores binary media only (curated images and derived audio cache), never game/session/player state; do not add a media DynamoDB table. v0.9 adds exactly one ephemeral `<env>-family-learning-games-multiplayer` table (rooms, memberships, answers, connections, room-code reservations; TTL on `expiresAt`); do not add further multiplayer tables or indexes without an ADR.

## Allowed in the v0.7 baseline
- AWS Amplify Hosting for the Next.js frontend, with the existing `play.joamgames.com` custom domain
- `amplify.yml` only if it adds real value over Amplify's auto-detection (currently: build + PWA revalidation headers)
- `.nvmrc` / Node version pinning for reproducible builds
- CDK `allowedOrigins` / `frontendOrigin` CORS configuration
- documentation of the manual GitHub↔Amplify connection and custom domain steps
- player profile CRUD through the existing Lambda/API and `Players` table
- age-aware AI generation via `targetAge` resolved from `playerId`
- Web App Manifest, PWA icons, Service Worker registration, versioned static caching (`joam-static-v*`), and offline fallback page
- tests for CORS configuration, CDK behavior, player rules, PWA cache classification/registration, and frontend configuration
- small, coherent refactors strictly needed to support the above

## Allowed in v0.8
- one private S3 media bucket, Polly `SynthesizeSpeech`, and scoped S3 permissions for the existing Lambda
- `POST /games/{gameId}/questions/{questionId}/audio` on the existing HTTP API
- optional `media.image` logical references and the controlled image catalog
- the frontend Listen button and optional question image
- tests for speech content, cache behavior, safe errors, media DTOs, CDK bucket/IAM, and the audio UI controller

## Allowed in v0.9
- one API Gateway WebSocket API (stage `production`, route selection `$request.body.action`) integrated with the existing Lambda
- `POST /multiplayer/rooms` and `POST /multiplayer/rooms/{roomCode}/join` on the existing HTTP API
- one TTL-backed multiplayer DynamoDB table and scoped `execute-api:ManageConnections`
- the frontend multiplayer flow (create/join, lobby, synchronized questions reusing v0.8 media, reveal, live scoreboard, podium)
- tests for scoring/ranking, state transitions, concurrency/idempotency, tokens, HTTP/WebSocket contracts, CDK resources/IAM and the client state/socket logic

## Out of scope
Do not add:
- Cognito/auth, user registration, login, password recovery, JWT, user/family accounts, roles/permissions, per-player authorization
- offline gameplay, offline session persistence, IndexedDB synchronization, Background Sync, push notifications/Web Push, cached API or Bedrock responses, native app packaging/store publication
- AI image generation, Bedrock image models, external image URLs, web image search, user/family photo uploads, avatars, camera/microphone, speech recognition, voice commands/cloning, model- or user-authored SSML, streaming audio, media CDN/CloudFront, SQS/Step Functions/EventBridge, offline caching of dynamic/private media
- AppSync/GraphQL subscriptions, Redis/ElastiCache, public matchmaking, friend lists, invitations, spectator mode, host migration, mid-game joining, offline multiplayer, persistent/global leaderboards, voice/video chat
- new game types (FASE 10)
- additional custom domains beyond `play.joamgames.com`
- GitHub Actions, CodePipeline, CodeBuild, Jenkins, ArgoCD, Terraform
- EC2, ECS, Fargate, EKS, manually managed S3+CloudFront, or a custom Lambda to serve the frontend
- a second backend Lambda, or any API beyond the existing HTTP API and the v0.9 multiplayer WebSocket API
- production-scale multi-environment redesign

## API compatibility
Do not remove or rename:

```text
GET  /game-setup
GET  /games
GET  /games/{gameId}
POST /game-sessions
GET  /game-sessions/{sessionId}
POST /game-sessions/{sessionId}/answers
POST /games/generate
POST /games/{gameId}/questions/{questionId}/audio
POST /multiplayer/rooms
POST /multiplayer/rooms/{roomCode}/join
GET    /players
POST   /players
PUT    /players/{playerId}
DELETE /players/{playerId}
```

`answers[].isCorrect` must never be public. WebSocket routes (`$connect`, `$disconnect`, `$default`, `IDENTIFY`, `START_GAME`, `SUBMIT_ANSWER`, `QUESTION_TIMEOUT`, `NEXT_QUESTION`, `SYNC_ROOM`) and server event types are part of the v0.9 contract; do not rename them.

## Security
Never expose in the frontend or in `NEXT_PUBLIC_*` values:

```text
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
Bedrock credentials
GitHub tokens
private API keys / secrets
```

Every `NEXT_PUBLIC_*` value must be assumed publicly visible from the browser. Only the public API base URL is appropriate there.

Player identity (`playerId`, name) must never be sent to Bedrock or Polly. Multiplayer participant tokens are capabilities: never log, broadcast, persist in plaintext, or place them in URLs. Signed media URLs, MP3 bytes, and object keys must never be logged. Service Worker caches must never store player data, game sessions, generated games, gameplay state, or AI results.

## Cost awareness
Prefer serverless, managed, pay-per-use resources. Amplify Hosting, Route 53 (hosted zone/domain for `play.joamgames.com`), API Gateway, Lambda, DynamoDB on-demand, and Bedrock were the billable services introduced across v0.1–v0.7; v0.8 adds Amazon Polly (characters synthesized on cache miss) and one S3 bucket (storage + requests). v0.9 adds API Gateway WebSocket connection minutes/messages, the Lambda invocations they trigger, and on-demand DynamoDB usage of the multiplayer table. Document any new potentially billable resource. Do not destroy or recreate existing stacks/tables.

## Testing
Normal tests must not require live AWS/Amplify. Test CORS/allowed-origins parsing and CDK configuration, default-disabled behavior, route preservation, player validation and AI data minimization, PWA cache classification and Service Worker registration, and frontend configuration. PWA lifecycle behavior must be validated against a production build (`npm run build` + `npm run start`), not only `npm run dev`. Do not add tests solely to raise coverage.

## Workflow for coding agents

1. Read docs.
2. Inspect current v0.7 code and infrastructure.
3. Preserve architectural boundaries and existing HTTP contracts.
4. Identify the minimal code/CDK/config delta needed for the task.
5. Add Amplify build configuration only if it adds real value.
6. Update frontend/deployment documentation.
7. Add/update tests together with code.
8. Run the standard project validations defined below.
9. Summarize changed files, AWS delta, test results, and manual deployment steps (including any Amplify Console step that requires interactive account-owner authorization).

Do not stop because the total change exceeds an arbitrary line limit. If a patch limit exists, use multiple coherent edits on the same branch.

Do not create branch chains unless explicitly requested.

Do not run Gentle AI, 4R, Judgment Day, or any Gentle AI-dependent review as part of the normal workflow unless the user explicitly requests that specific review for the current task.

## Gentle AI policy

`gentle-ai` is optional for this project and is **opt-in only**.

Do **not** execute any `gentle-ai` command unless the user explicitly requests Gentle AI in the current task.

This includes, but is not limited to:

- `gentle-ai review`
- `gentle-ai review finalize`
- 4R reviews
- Judgment Day / dual adversarial review
- automated Gentle AI reviewers
- Gentle AI PR workflows
- Gentle AI issue workflows
- `gentle-ai skill-registry refresh`
- any subagent, skill, hook, or workflow whose execution invokes `gentle-ai`

The presence of any of the following does **not** constitute authorization to execute Gentle AI:

- `.atl/skill-registry.md`
- Gentle AI skills under `~/.config/opencode/skills`
- Gentle AI skills under `~/.codex/skills`
- a `gentle-ai` binary installed in the environment
- previously generated Gentle AI review state or receipts
- a previous `escalated`, `inconclusive`, or failed Gentle AI review

Default project validation is the standard validation section below.

Gentle AI may be used only when the user explicitly says something equivalent to:

- "run gentle-ai"
- "run the 4R review"
- "use judgment-day"
- "perform a Gentle AI review"

Do **not** infer Gentle AI authorization from generic instructions such as:

- review
- validate
- check
- verify
- inspect
- test
- audit

unless Gentle AI or a specific Gentle AI workflow is explicitly named.

A Gentle AI failure, escalation, receipt, or previous review state must **not** block normal project work, validation, commit preparation, or completion reporting unless the user explicitly required Gentle AI as a gate for the current task.

Do not edit, override, fabricate, or manually approve Gentle AI receipts or review state.

## Skill selection policy

Skills may be discovered and read when relevant, but a skill must not be loaded or executed if its required workflow invokes `gentle-ai`, unless the user explicitly authorized Gentle AI for the current task.

If a matching skill depends on Gentle AI and Gentle AI was not explicitly authorized:

- skip that skill;
- continue using the project instructions in `AGENTS.md` and the mandatory architecture documentation;
- report `skill_resolution: skipped_gentle_ai` when skill resolution is part of the agent's output;
- do not treat the skipped skill as a blocker;
- do not replace it with another Gentle AI workflow.

The skill registry is an index only. Its existence does not override this policy.

## Validation

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

## Definition of Done
v0.9 is complete when (in addition to the v0.8 and v0.7 criteria below):
- a host creates a room, other family players join by room code from their own devices, and everyone receives the same questions in real time
- membership uses only the hashed, room-scoped `participantToken` and `IDENTIFY`; no Cognito/login was introduced
- answers, deadlines, correctness, scoring (`1000 + 300/200/100`, fast incorrect = 0) and the podium comparator are server-authoritative and identical on every device
- all-answered and timeout reveals happen exactly once under duplicate/concurrent commands; reconnect preserves role, score, answers and progress; stale connections never break broadcasts
- the same Lambda serves HTTP + WebSocket, exactly one new (TTL) DynamoDB table exists, single-player and v0.8 media keep working, and validation commands pass

v0.8 is complete when (in addition to the v0.7 criteria below):
- a question and its options can be listened to on demand, with the text derived from the persisted game and never from the client
- repeated requests reuse cached audio from the private bucket without calling Polly again
- optional controlled images render with alt text; questions without images are unchanged
- media failures never block gameplay; `isCorrect` is never exposed
- no second Lambda/API, no new DynamoDB table, no AI image generation, and the v0.7.1 AI pipeline is unchanged
- the PWA remains online-first and validation commands pass

v0.7 (baseline) is complete when:
- the app loads normally at `https://play.joamgames.com`, deployed from GitHub through AWS Amplify Hosting
- the Web App Manifest is valid and the app is installable (desktop and mobile) as JOAM Games with its icons
- a Service Worker installs and activates, caches only static resources, and removes obsolete `joam-static-*` caches on activation
- backend/API responses are never served from or persisted in the PWA cache
- an uncached navigation while offline shows the controlled offline fallback, and restoring connectivity restores normal behavior
- player profiles and age-aware AI generation keep working, with player identity never crossing the AI boundary
- `NEXT_PUBLIC_GAME_API_BASE_URL` remains external configuration
- CORS supports `http://localhost:3000` and the public origin(s), configured explicitly (never `*`)
- the existing backend Lambda, API routes, DynamoDB tables, and Bedrock integration are preserved unchanged in contract
- the full seeded-game flow, player flow, and, when enabled, AI generation work end to end through the public frontend
- no auth, offline gameplay, multimedia, or multiplayer feature was introduced
- validation commands pass
- deployment documentation (backend CDK + manual Amplify/GitHub/custom domain steps + CORS follow-up) is current

> **Installable online-first PWA with static offline fallback, not an offline-first application. Multiplayer is online only.**
