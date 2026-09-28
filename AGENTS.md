# Family Learning Games — AGENTS.md

## Current target
> **v0.7.1 — AI generation quality and operational hardening**

## Current roadmap phase
> **FASE 7 — PWA** (completed)
>
> **v0.7.1** is a patch over the completed Phase 7 baseline, not a new phase.

## Mandatory documentation
Before modifying v0.7.1 code, read:

1. `AGENTS.md`
2. `docs/architecture/ARCHITECTURE-v0.7.1.md`
3. `docs/architecture/ADR-015-claude-sonnet-ai-generation-quality.md`
4. `docs/architecture/REQUIREMENTS-v0.7.1.md`
5. `docs/architecture/ARCHITECTURE-v0.7.md`
6. `docs/architecture/ADR-014-pwa-online-first.md`
7. `docs/architecture/REQUIREMENTS-v0.7.md`
8. ADR-011, ADR-012 and ADR-013 when touching AI generation, players, or AI personalization.

Previous accepted architecture/ADRs remain relevant unless superseded. In particular:

- `ADR-009-ai-game-validation-and-identity.md` remains the accepted decision for AI-generated game validation and identity.
- `ADR-010.md` is the only ADR that decides AWS Amplify Hosting for the public frontend.
- `ADR-011-two-model-ai-generation-pipeline.md` decides the two-model AI generation pipeline.
- `ADR-012.md` decides persistent family player profiles.
- `ADR-013.md` decides age-aware AI personalization derived from player profiles.
- `ADR-014-pwa-online-first.md` decides the online-first PWA with controlled static caching.
- `ADR-015-claude-sonnet-ai-generation-quality.md` evolves the ADR-011 AI pipeline implementation for v0.7.1: Claude Sonnet 4.6, stronger difficulty/diversity requirements, answer-order verification, bounded observability, and synchronous execution-budget awareness.

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
   ↓
GameApiClient                     (backend requests: NETWORK ONLY)
   ↓
API Gateway HTTP API
   ↓
AWS Lambda
   ↓
Application
   ├── GameGenerator / GameValidator ──► Bedrock adapters ──► Amazon Bedrock
   └── Repository ports (Game, GameSession, Player) ──► DynamoDB repositories ──► DynamoDB
   ↓
Domain (game, player)
```

## Mandatory rules

### Domain is AWS-independent
No AWS SDK, Amplify, Bedrock, Lambda, API Gateway, DynamoDB, or CDK imports in Domain.

### Application is provider-independent
Application depends on `GameGenerator`, never directly on Bedrock SDK types.

### Frontend hosting is presentation-only infrastructure
AWS Amplify Hosting only builds and serves the Next.js frontend. It never becomes a second backend, never receives AWS credentials, and never bypasses `GameApiClient`.

### One backend Lambda
Reuse the existing `family-learning-games-backend` Lambda and its HTTP API. Do not create a second Lambda or a separate API to serve the frontend.

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
NEXT_PUBLIC_GAME_API_BASE_URL
```

AI generation defaults to disabled. Bedrock generator/validator models, region, and Guardrail configuration are required only when it is enabled. The model IDs remain configuration and must not be hardcoded in Domain/Application.

`ADR-011` continues to define the independent Generator/Validator pipeline and deterministic Application validation. `ADR-015` defines the v0.7.1 model/configuration and quality evolution.

## Persistence
Use the existing `Games`, `GameSessions`, and `Players` tables (`Players`: PK = `playerId`, no secondary indexes). Do not introduce RDS, Aurora, S3-as-database, Redis, or ElastiCache. The Service Worker cache and browser storage are not application persistence.

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

## Out of scope
Do not add:
- Cognito/auth, user registration, login, password recovery, JWT, user/family accounts, roles/permissions, per-player authorization
- offline gameplay, offline session persistence, IndexedDB synchronization, Background Sync, push notifications/Web Push, cached API or Bedrock responses, native app packaging/store publication
- Polly, S3 media, image/voice generation (FASE 8)
- WebSockets, AppSync subscriptions, multiplayer/real-time state (FASE 9)
- new game types (FASE 10)
- additional custom domains beyond `play.joamgames.com`
- GitHub Actions, CodePipeline, CodeBuild, Jenkins, ArgoCD, Terraform
- EC2, ECS, Fargate, EKS, manually managed S3+CloudFront, or a custom Lambda to serve the frontend
- a second backend Lambda or a second API
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
GET    /players
POST   /players
PUT    /players/{playerId}
DELETE /players/{playerId}
```

`answers[].isCorrect` must never be public.

## Security
Never expose in the frontend or in `NEXT_PUBLIC_*` values:

```text
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
Bedrock credentials
GitHub tokens
private API keys / secrets
```

Every `NEXT_PUBLIC_*` value must be assumed publicly visible from the browser. Only the public API base URL is appropriate there.

Player identity (`playerId`, name) must never be sent to Bedrock. Service Worker caches must never store player data, game sessions, generated games, gameplay state, or AI results.

## Cost awareness
Prefer serverless, managed, pay-per-use resources. Amplify Hosting, Route 53 (hosted zone/domain for `play.joamgames.com`), API Gateway, Lambda, DynamoDB on-demand, and Bedrock remain the only billable services introduced across v0.1–v0.7. Document any new potentially billable resource. Do not destroy or recreate existing stacks/tables.

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
v0.7 (current baseline) is complete when:
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

> **Installable online-first PWA with static offline fallback, not an offline-first application.**
