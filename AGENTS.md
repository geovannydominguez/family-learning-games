# Family Learning Games — AGENTS.md

## Current target
> **v0.5 — Public Deployment on AWS**

## Current roadmap phase
> **FASE 5 — Desplegar públicamente en AWS**

## Mandatory documentation
Before modifying code, read:

1. `AGENTS.md`
2. `docs/architecture/ARCHITECTURE-v0.5.md`
3. `docs/architecture/ADR-010.md`
4. `docs/architecture/REQUIREMENTS-v0.5.md`

Previous accepted architecture/ADRs remain relevant unless superseded. In particular, `ADR-009-ai-game-validation-and-identity.md` is unrelated to hosting and remains the accepted decision for AI-generated game validation and identity; `ADR-010.md` is the only ADR that decides AWS Amplify Hosting for the public frontend.

## Architecture

```text
GitHub
   ↓
AWS Amplify Hosting
   ↓
Next.js
   ↓
GameApiClient
   ↓
API Gateway HTTP API
   ↓
AWS Lambda
   ↓
Application
   ├── GameGenerator ──► BedrockGameGenerator ──► Amazon Bedrock
   └── Repository ports ──► DynamoDB repositories ──► DynamoDB
   ↓
Domain
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

Default is `http://localhost:3000` when neither is supplied. Do not remove local development support. Do not hardcode a specific Amplify-generated domain in code; pass it through `allowedOrigins` at deploy time instead. Never set an allowed origin to `*`.

## Deployment model
Frontend deployment flows from GitHub through AWS Amplify Hosting:

```text
git push → GitHub → Amplify build/deploy → public HTTPS URL
```

Do not introduce GitHub Actions, CodePipeline, CodeBuild, Jenkins, ArgoCD, or Terraform to satisfy v0.5. Amplify's own GitHub integration handles checkout, install, build, and deploy. Connecting the GitHub repository to a new Amplify app is an interactive, account-owner action performed in the AWS Console; it is not automated by CDK in v0.5.

## Circular CORS/Amplify dependency
The Amplify public origin is only known after the Amplify app exists, but the backend must allow that origin. Resolve this explicitly, never by opening CORS with `*`:

```text
1. Deploy the backend (default/localhost-only CORS is fine initially).
2. Create the Amplify app connected to GitHub and let it build once.
3. Read the generated Amplify domain.
4. Redeploy the backend with allowedOrigins including localhost and that domain.
5. Set NEXT_PUBLIC_GAME_API_BASE_URL in Amplify and redeploy the frontend.
6. Validate the public flow end to end.
```

## Configuration
Do not hardcode models, Guardrails, or origins in Domain/Application.

Use configuration such as:

```text
AI_GAME_GENERATION_ENABLED
BEDROCK_GENERATOR_MODEL_ID   # amazon.nova-lite-v1:0
BEDROCK_VALIDATOR_MODEL_ID   # amazon.nova-pro-v1:0
BEDROCK_REGION
BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
NEXT_PUBLIC_GAME_API_BASE_URL
```

AI generation defaults to disabled. Bedrock generator/validator models, region, and Guardrail configuration are required only when it is enabled. See `ADR-011` for the two-model generation pipeline (Nova Lite drafts; Nova Pro blind-solves each question; Application deterministically compares answers before persistence).

## Persistence
Use the existing `Games` and `GameSessions` tables. Do not introduce RDS, Aurora, S3-as-database, Redis, or ElastiCache to satisfy v0.5.

## Allowed in v0.5
- AWS Amplify Hosting for the Next.js frontend
- `amplify.yml` only if it adds real value over Amplify's auto-detection
- `.nvmrc` / Node version pinning for reproducible builds
- CDK `allowedOrigins` / `frontendOrigin` CORS configuration
- documentation of the manual GitHub↔Amplify connection steps
- tests for CORS configuration, CDK behavior, and frontend configuration
- small, coherent refactors strictly needed to support public deployment

## Out of scope
Do not add:
- Cognito/auth, user registration, login, password recovery, JWT, family accounts, roles/permissions (FASE 6)
- service workers, offline mode, installable app, web manifest as a feature, push notifications (FASE 7)
- Polly, S3 media, image/voice generation (FASE 8)
- WebSockets, AppSync subscriptions, multiplayer/real-time state (FASE 9)
- new game types (FASE 10)
- a purchased/custom domain (the Amplify-managed domain is sufficient)
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

## Cost awareness
Prefer serverless, managed, pay-per-use resources. Amplify Hosting, API Gateway, Lambda, DynamoDB on-demand, and Bedrock remain the only billable services introduced across v0.1–v0.5. Document any new potentially billable resource. Do not destroy or recreate existing stacks/tables to satisfy v0.5.

## Testing
Normal tests must not require live AWS/Amplify. Test CORS/allowed-origins parsing and CDK configuration, default-disabled behavior, route preservation, and frontend configuration. Do not add tests solely to raise coverage.

## Workflow for coding agents

1. Read docs.
2. Inspect current v0.4 code and infrastructure.
3. Preserve architectural boundaries and existing HTTP contracts.
4. Identify the minimal CDK/config delta needed for public hosting and CORS.
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
v0.5 is complete when:
- the frontend is deployable to AWS Amplify Hosting from the GitHub repository
- the app is reachable over a public HTTPS URL without running `npm run dev`
- `NEXT_PUBLIC_GAME_API_BASE_URL` remains external configuration
- CORS supports both `http://localhost:3000` and the public Amplify origin, configured explicitly (never `*`)
- the existing backend Lambda, API routes, DynamoDB tables, and Bedrock integration are preserved unchanged in contract
- the full seeded-game flow and, when enabled, AI generation work end to end through the public frontend
- no Cognito, PWA, multimedia, or multiplayer feature was introduced
- no custom domain is required
- validation commands pass
- deployment documentation (backend CDK + manual Amplify/GitHub steps + CORS follow-up) is current

> **Publish what already works, without turning deployment into a new platform.**
