# Family Learning Games

**Family Learning Games v0.8 — FASE 8: Audio / imágenes.** A family quiz app published at `https://play.joamgames.com` as an installable, online-first PWA (v0.7, ADR-014) served by AWS Amplify Hosting, backed by one API Gateway HTTP API and one Lambda with DynamoDB (games, sessions, family player profiles). AI-generated games use a two-model Claude Sonnet 4.6 Generator/Validator pipeline on Amazon Bedrock with age-aware personalization (v0.6) and the v0.7.1 quality and execution-budget hardening. v0.8 adds on-demand spoken questions through Amazon Polly and optional curated question images, both stored in one private S3 bucket and delivered through short-lived signed URLs (ADR-016, ADR-017).

AI generation is **disabled by default**. Enabling it is an intentional deployment decision.

## Architecture

```text
GitHub
    ↓ git push
AWS Amplify Hosting
    ↓ HTTPS
Next.js UI
    ↓ HTTPS / JSON
GameApiClient
    ↓
API Gateway HTTP API
    ↓
One Lambda router
    ↓
Application / Domain
    ├── GameGenerator port → BedrockGameGenerator → Amazon Bedrock
    ├── SpeechSynthesizer port → PollySpeechSynthesizer → Amazon Polly   (v0.8)
    ├── MediaObjectStore port → S3MediaObjectStore → private S3 media bucket (v0.8)
    └── Repository ports → DynamoDB repositories → Games + GameSessions + Players
```

The Domain and Application layers remain AWS-independent. The browser never receives AWS, model, Guardrail, prompt, or answer-key details. Generated content passes through a fixed product prompt, Bedrock Guardrail, an independent validator, and deep application validation, with bounded question-level repair rounds (v0.7.1), before it is stored. Amplify Hosting only builds and serves the frontend; it never gains AWS credentials of its own and never becomes a second backend.

## Local verification

```bash
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
npx cdk synth FamilyLearningGamesBackendStack
npx cdk synth FamilyLearningGamesBackendStack -c aiGameGenerationEnabled=true
```

Tests use injected clients and do not call live AWS services. `npm run build` produces a fully static/prerendered `.next` output for this app (no middleware, server actions, or dynamic API routes), which is the same artifact Amplify's build produces.

## CDK configuration

| Context key | Default | Purpose |
| --- | --- | --- |
| `environment` | `dev` | Prefix for physical resource names. |
| `allowedOrigins` | (unset) | Comma-separated list of exact CORS origins (e.g. `http://localhost:3000,https://main.d123.amplifyapp.com`). Takes precedence over `frontendOrigin`. |
| `frontendOrigin` | `http://localhost:3000` | Single exact CORS origin; backward-compatible fallback used only when `allowedOrigins` is not set. |
| `aiGameGenerationEnabled` | `false` | Opts the deployment into Bedrock generation. |
| `bedrockGeneratorModelId` | `global.anthropic.claude-sonnet-4-6` | Generator model (ADR-015), used only when AI is enabled. |
| `bedrockValidatorModelId` | `global.anthropic.claude-sonnet-4-6` | Independent validator model (ADR-011/ADR-015), used only when AI is enabled. |
| `deploymentRegion` | `us-east-1` | Region for the complete stack, including Bedrock Runtime, its model ARN, and the Guardrail. |
| `generationThrottleRateLimit` | `1` | Rate limit for `POST /games/generate`, in requests/second. |
| `generationThrottleBurstLimit` | `2` | Burst limit for `POST /games/generate`. |
| `audioCacheVersion` | `v1` | Part of the audio cache key; bump it to invalidate cached audio after a voice/prosody policy change. |
| `audioCacheExpirationDays` | `30` | Lifecycle expiration for the derived `audio-cache/` prefix only. |

Boolean context values accept only `true` or `false`. Throttle values must be positive, and the burst limit must be an integer. Each origin must be an `http://` or `https://` URL with no trailing slash; the stack never accepts `*` as an origin.
Choose one `<region>` for the deployment and repeat `-c deploymentRegion=<region>` on every CDK lifecycle command. Omitting it targets the default `us-east-1`, regardless of the AWS profile's configured region.

When AI is enabled, CDK provisions one family-safe Bedrock Guardrail and one published version. Lambda receives `BEDROCK_GENERATOR_MODEL_ID`, `BEDROCK_VALIDATOR_MODEL_ID`, `BEDROCK_REGION`, `BEDROCK_GUARDRAIL_ID`, and `BEDROCK_GUARDRAIL_VERSION`, uses a 28-second timeout, and receives resource-scoped `bedrock:InvokeModel`, `bedrock:ApplyGuardrail`, and Games-table `dynamodb:PutItem` permissions. `BEDROCK_REGION` is always the stack deployment region, so the Guardrail, Runtime client, and model ARN cannot be configured cross-region. Model IDs are set with `-c bedrockGeneratorModelId=...` / `-c bedrockValidatorModelId=...`; a cross-region inference profile ID (for example `global.anthropic.claude-sonnet-4-6`) is granted on its `inference-profile` ARN plus the underlying `foundation-model` ARNs it routes to. Change models through CDK context, not by editing the Lambda environment in the console: the IAM policy is derived from these IDs and the next deploy would overwrite manual edits. Disabled deployments keep the 10-second timeout, cannot write to the Games table, and provision no Bedrock resources or permissions.

Generated candidates enforce these additional metadata limits before persistence: category ID 80 characters, category name 100, category description 300, category icon 16, question ID 80, answer ID 80, emoji 16, and image reference 2048. Every supplied field is trimmed and must remain non-empty; the existing title/question/answer limits remain 100/240/120.

Only `POST /games/generate` is throttled at the API stage. A `429` response is shown as a friendly retry-later message; the client and UI NEVER perform aggressive or automatic retries.

## Manual deployment

Replace `<aws-profile>` before copying these examples. The commands below are operational instructions; **none were executed against a real AWS account while documenting v0.5–v0.8**.

```bash
# Verify the target account and configured region first.
aws sts get-caller-identity --profile <aws-profile>
aws configure get region --profile <aws-profile>

# Review and deploy with AI disabled (default).
npx cdk diff FamilyLearningGamesBackendStack --profile <aws-profile> \
  -c deploymentRegion=<region>
npx cdk deploy FamilyLearningGamesBackendStack --profile <aws-profile> \
  -c deploymentRegion=<region>

# Review and deploy with AI enabled.
npx cdk diff FamilyLearningGamesBackendStack \
  --profile <aws-profile> \
  -c aiGameGenerationEnabled=true \
  -c bedrockGeneratorModelId=global.anthropic.claude-sonnet-4-6 \
  -c bedrockValidatorModelId=global.anthropic.claude-sonnet-4-6 \
  -c deploymentRegion=<region> \
  -c generationThrottleRateLimit=1 \
  -c generationThrottleBurstLimit=2

npx cdk deploy FamilyLearningGamesBackendStack \
  --profile <aws-profile> \
  -c aiGameGenerationEnabled=true \
  -c bedrockGeneratorModelId=global.anthropic.claude-sonnet-4-6 \
  -c bedrockValidatorModelId=global.anthropic.claude-sonnet-4-6 \
  -c deploymentRegion=<region> \
  -c generationThrottleRateLimit=1 \
  -c generationThrottleBurstLimit=2
```

For a first deployment in an account/region:

```bash
npx cdk bootstrap --profile <aws-profile> \
  -c deploymentRegion=<region>
```

Deployment outputs include `ApiUrl`, `FunctionName`, `GamesTableName`, and `GameSessionsTableName`. Configure the frontend and restart or rebuild Next.js:

```dotenv
NEXT_PUBLIC_GAME_API_BASE_URL=https://your-api-id.execute-api.your-region.amazonaws.com
```

## Public frontend hosting (AWS Amplify)

### Prerequisites

```text
AWS account with permission to create an Amplify app
Personal GitHub account with access to this repository
AWS CLI configured (AWS_PROFILE / AWS_REGION)
Node.js 22 and npm (see .nvmrc)
```

### Next.js/Amplify compatibility checkpoint

This app runs Next.js `15.5.24` / React `19.1.0` / Node `22` (see `package.json`, `package-lock.json`, `.nvmrc`; the CDK Lambda already targets `NODEJS_22_X`). `npm run build` produces a fully static/prerendered output — there is no middleware, server action, or dynamic route — so Amplify Hosting's standard Next.js build path applies with no framework downgrade or migration. `amplify.yml` at the repo root pins the build to `npm ci` (respecting `package-lock.json`) and `npm run build`, with `baseDirectory: .next`, matching the local build exactly.

### Connect GitHub → Amplify (manual, one-time, interactive)

Creating the Amplify app and authorizing its GitHub App requires the AWS account owner in the console; it is intentionally not automated by CDK in v0.5:

```text
AWS Console
  → Amplify
  → Create app / Host web app
  → GitHub
  → Authorize the AWS Amplify GitHub App
  → select the family-learning-games repository
  → select the main branch
  → confirm the detected build settings (amplify.yml)
  → configure environment variables (see below)
  → deploy
```

### Environment variables (Amplify Console → App settings → Environment variables)

```text
NEXT_PUBLIC_GAME_API_BASE_URL=<ApiUrl from the CDK deployment output>
```

Do not add any `AWS_*`, Bedrock, or GitHub credential to Amplify's environment variables. Every `NEXT_PUBLIC_*` value is publicly visible in the browser bundle; only the public API base URL belongs there.

### Resolving the CORS ↔ Amplify domain order

The public Amplify domain is only known after the app exists, but the backend must already allow it. Do this in order, and never allow `*`:

```text
1. Deploy the backend once (default CORS: http://localhost:3000 only).
2. Create the Amplify app above and let the first build/deploy finish.
3. Copy the generated domain, e.g. https://main.d123456789.amplifyapp.com.
4. Redeploy the backend with both origins:
     npx cdk deploy FamilyLearningGamesBackendStack \
       --profile <aws-profile> \
       -c deploymentRegion=<region> \
       -c allowedOrigins="http://localhost:3000,https://main.d123456789.amplifyapp.com"
5. Set NEXT_PUBLIC_GAME_API_BASE_URL in Amplify to the backend's ApiUrl and
   trigger "Redeploy this version" in the Amplify Console.
6. Open the public URL and confirm the full game flow with no CORS errors.
```

Re-run step 4 (adding the new origin to the existing `allowedOrigins` list) whenever a new Amplify branch/domain is added; local development on `http://localhost:3000` keeps working throughout.

### Cost awareness

Amplify Hosting bills per build minute and per GB served — both usage-based, no always-on server. It is billed independently from, and in addition to, the existing API Gateway/Lambda/DynamoDB/Bedrock usage-based charges. Review Amplify build minutes and data transfer alongside the existing Bedrock/Lambda cost checks below once the app is public.

## AI generation quality and runtime behavior (v0.7.1)

See `docs/architecture/ADR-015-claude-sonnet-ai-generation-quality.md`. Generator and validator remain two independent, stateless Converse calls followed by the deterministic Application comparison (ADR-011); the guarded-topic mechanism and the Guardrail are unchanged.

- **Difficulty.** The generator prompt defines explicit `easy` / `normal` / `hard` semantics, plus intra-game diversity and same-kind, plausible distractor rules. `targetAge` still sets the age boundaries; `difficulty` sets the challenge inside them.
- **Answer order.** Application shuffles each accepted question's answers after validation and before assigning answer ids, so neither position nor id reveals the correct answer. The model is never asked to randomize.
- **Execution budget.** The Lambda handler passes `context.getRemainingTimeInMillis()` to Application. Each AI call is costed by its batch size `n`: generator `3000 + 1200·n` ms, validator `3000 + 450·n` ms, plus a 1 s margin (a generation must fit generator + validator + margin; a validation, validator + margin). A call slower than its estimate raises that role's factor (never below 1) for the rest of the request. So a 9/10 round costs its repair as 1 question and can still run; larger repairs run only if the remaining time allows. When a call does not fit, the request ends with the existing `422 AI_GENERATED_CONTENT_INVALID` (or `502 AI_GENERATION_FAILED` if the unaffordable call is a provider-error retry) and logs `AI_GAME_EXECUTION_BUDGET_EXHAUSTED`, instead of being killed by the 28 s timeout. `maxRepairRounds = 5` is an upper bound, not a guarantee. The constants come from a controlled 30-call measurement (see ADR-015), not a Bedrock SLA. Policy: `src/application/game/executionBudget.ts`.
- **Observability.** Every `AI_GAME_*` event carries `correlationId` (the API Gateway request id), `difficulty`, `targetAge`, `topicHash` (SHA-256 of the trimmed, NFC, lower-cased, whitespace-collapsed topic), and the model ids. `AI_GAME_REPAIR_ROUND` adds `generatorDurationMs` / `validatorDurationMs`; a semantic `AI_GAME_VALIDATION_REJECTED` adds the validator `reason`, collapsed to one line and truncated to 200 characters. The topic in clear, questions, prompts, `playerId`, and player names are never logged. `topicHash` is for correlation only, not a security control: a guessable topic can be recovered by hashing candidates.

To find all attempts for one topic in CloudWatch Logs Insights, compute its hash locally and filter on it:

```bash
node -e 'const t=process.argv[1].normalize("NFC").trim().toLowerCase().replace(/\s+/g," ");console.log(require("crypto").createHash("sha256").update(t).digest("hex"))' "Mundiales de Fútbol"
```

## Question audio and images (v0.8)

See `docs/architecture/ARCHITECTURE-V0.8.md`, `ADR-016-game-media-assets-private-s3.md` and `ADR-017-amazon-polly-question-audio.md`. Media is an optional enhancement: every game stays fully playable when audio or images fail.

**Audio.** The question screen has an explicit "🔊 Escuchar pregunta" button (never autoplay). It calls:

```bash
curl --fail-with-body --show-error --silent \
  -X POST "${API_URL}/games/<gameId>/questions/<questionId>/audio" \
  -H 'content-type: application/json' -d '{}'
# 200 → {"audioUrl":"<short-lived signed URL>","expiresAt":"2026-10-03T12:15:00.000Z"}
```

The request accepts identifiers only; any body field (`text`, `ssml`, `voiceId`, …) is rejected with `400 INVALID_REQUEST`, so the API is never a general-purpose TTS proxy. The backend loads the persisted game, builds Spanish plain text from the question and its options in displayed order (`Opción 1: …`), never including `isCorrect`, IDs, emoji or player data, and bounds it to 1500 characters. The MP3 is cached in the private bucket at `audio-cache/<version>/<sha256(version, language, voice profile, text)>.mp3`: a cache hit returns a fresh signed URL without calling Polly; a miss synthesizes once and stores the object. Signed URLs live 900 s and are never persisted or logged. v0.8 has one fixed speech profile, not configurable per deploy: voice `Lupe`, engine `neural`, language `es-US` (sent as Polly `LanguageCode`), output `mp3`. The spoken labels are Spanish; there is no language or voice selection and no i18n. Known limitation: two simultaneous cache-miss requests for the same question may each call Polly once (identical object, bounded cost). Responses use the existing HTTP contract (endpoint-specific success body; errors as `{"error":{"code","message"}}`). Errors: `400 INVALID_REQUEST` (any body field or malformed ID), `404 RESOURCE_NOT_FOUND` (unknown game/question), `422 QUESTION_AUDIO_UNSUPPORTED` (nothing speakable / too long), `502 QUESTION_AUDIO_FAILED` (Polly/S3 failure, no provider details), `503 QUESTION_AUDIO_DISABLED` (no media bucket configured). Audio is never synthesized during `POST /games/generate`; the v0.7.1 AI pipeline and execution budget are unchanged. Structured events: `QUESTION_AUDIO_REQUESTED`, `_CACHE_HIT`, `_CACHE_MISS`, `_SYNTHESIZED` (with `durationMs`), `_FAILED` (with a safe `stage`/`errorName`).

**Images.** A question may carry `media.image = { assetId, altText }` (a logical, curated reference, never a URL). Public game/session question DTOs then expose it additively as `media: { image: { url, altText } }` with a 900 s signed URL; questions without an image keep exactly the previous shape. The legacy public `image` string (since v0.2, a free-form reference the AI Generator may emit) is unchanged and still passed through for backward compatibility; the frontend renders only `media.image`. Images are resolved only through the controlled catalog `src/data/mediaCatalog.json` (`assetId → images/….webp|png|jpg`); unknown, invalid or failing assets degrade to text-only (`QUESTION_IMAGE_MISSING` / `_FAILED` events). The catalog ships empty. To add a curated image:

1. Prepare a child-appropriate, licensed image that does not reveal the answer, as WebP (preferred), PNG or JPEG, at most 300 KB.
2. Upload it to the media bucket (`MediaBucketName` stack output) under `images/`, e.g. `aws s3 cp dolphin-01.webp s3://<MediaBucketName>/images/animals/dolphin-01.webp --content-type image/webp`.
3. Register `{ "assetId": "animals/dolphin-01", "objectKey": "images/animals/dolphin-01.webp" }` in `src/data/mediaCatalog.json` and redeploy the backend.
4. Reference it from a seeded question (`"media": { "image": { "assetId": "animals/dolphin-01", "altText": "Un delfín nadando en el océano" } }`) and reseed. Seeding rejects malformed references. AI-generated games never receive images in v0.8.

**Infrastructure.** One private S3 bucket (`GameMediaBucket`): all public access blocked, ACLs disabled (bucket-owner enforced), SSE-S3 encryption, TLS-only bucket policy, CORS limited to `allowedOrigins` (GET/HEAD), lifecycle expiration only on `audio-cache/`. Removal follows the `environment` context: the default `dev` uses `RemovalPolicy.DESTROY` + `autoDeleteObjects` (CDK adds its deploy-time cleanup handler, invoked only when the bucket is deleted; it is not an application Lambda), while `prod`/`production` uses `RemovalPolicy.RETAIN`. The existing Lambda receives `s3:GetObject` on `audio-cache/*` and `images/*`, `s3:PutObject` on `audio-cache/*` only, `s3:ListBucket` on that bucket (so a missing cache object is a 404 miss, not a 403), and `polly:SynthesizeSpeech` (Polly scopes this action only by lexicon ARN and no lexicons are used, so its resource is `*`). New Lambda environment: `MEDIA_BUCKET_NAME`, `POLLY_VOICE_ID`, `POLLY_ENGINE`, `POLLY_LANGUAGE_CODE`, `POLLY_OUTPUT_FORMAT` (`mp3`), `AUDIO_URL_TTL_SECONDS`, `IMAGE_URL_TTL_SECONDS`, `AUDIO_CACHE_VERSION`. Polly/S3 clients use bounded retries and request timeouts so failures return inside the Lambda timeout.

**PWA.** Unchanged (ADR-014). Signed S3 URLs are cross-origin, so the Service Worker never intercepts or caches them; the audio API call is a `POST` and stays network-only.

**Cost.** New usage-based charges: Polly characters synthesized (cache misses only), S3 storage and GET/PUT/HEAD requests. No always-on compute and no image-generation inference.

## Generated-game API flow

Generate exactly ten questions:

```bash
API_URL=https://your-api-id.execute-api.your-region.amazonaws.com

curl --fail-with-body --show-error --silent \
  -X POST "${API_URL}/games/generate" \
  -H 'content-type: application/json' \
  -d '{"topic":"The solar system","difficulty":"normal","questionCount":10}'
```

A successful `201` response is a public game: it does not contain `isCorrect`, provider output, prompts, Guardrail details, or AWS errors. Its public identity field is `id`; use that value as `<generated-game-id>` for `GET /games/{gameId}` and as the `gameId` request field when starting a session:

```bash
curl --fail-with-body --show-error --silent \
  "${API_URL}/games/<generated-game-id>"

curl --fail-with-body --show-error --silent \
  -X POST "${API_URL}/game-sessions" \
  -H 'content-type: application/json' \
  -d '{
    "playerId":"player-1",
    "categoryId":"<generated-category-id>",
    "gameId":"<generated-game-id>",
    "difficulty":"normal"
  }'
```

When both `gameId` and `categoryId` are present, the selected game must belong to that category. Existing seeded-game clients remain compatible by omitting `gameId`.

Generation-specific responses include `400` for invalid input, `409` for an ID collision, `422` for invalid generated content after the bounded repair rounds or an exhausted execution budget, `429` for route throttling, `502` for a provider failure, and `503` when generation is disabled. Error bodies remain application-safe.

## Persistence, seed, and cost checks

DynamoDB table names follow:

```text
<environment>-family-learning-games-games
<environment>-family-learning-games-game-sessions
<environment>-family-learning-games-players
```

Seed the standard games after the first deploy or any destroy/redeploy:

```bash
AWS_PROFILE=<aws-profile> npm run seed:games -- \
  --table-name <GamesTableName>
```

Seeding restores the standard catalog only. It does not recreate AI-generated games or sessions.

Generation is synchronous and user-triggered, uses at most 4096 output tokens, repairs invalid questions in at most 5 bounded rounds within the execution budget (v0.7.1), and is route-throttled at 1 request/second with burst 2. Throttling is NOT authentication or a spend quota. After an enabled test:

- inspect Bedrock usage/costs for the configured region and model;
- inspect Lambda/API logs for status, duration, and throttling;
- verify logs do not contain prompts, raw provider output, family/private data, or provider request details;
- disable or destroy the feature when it is not needed.

## Disable, rollback, and destroy

To disable AI while preserving the API and stored games, review and deploy the false context:

```bash
npx cdk diff FamilyLearningGamesBackendStack \
  --profile <aws-profile> \
  -c deploymentRegion=<region> \
  -c aiGameGenerationEnabled=false

npx cdk deploy FamilyLearningGamesBackendStack \
  --profile <aws-profile> \
  -c deploymentRegion=<region> \
  -c aiGameGenerationEnabled=false
```

This removes the Guardrail resources and Bedrock IAM/configuration, restores the 10-second Lambda timeout, and keeps `POST /games/generate` available as a safe `503`. Previously generated games remain in DynamoDB.

To remove the development stack:

```bash
npx cdk destroy FamilyLearningGamesBackendStack --profile <aws-profile> \
  -c deploymentRegion=<region>
```

The development tables use `RemovalPolicy.DESTROY`. Destroying the stack permanently deletes seeded/generated games, sessions, the API, Lambda, Guardrail, and managed logs; CDK bootstrap resources remain. A later deployment requires reseeding. In the default `dev` environment the v0.8 media bucket is emptied and deleted too (curated images included — keep the originals outside S3 and re-upload them after a clean deploy). With `-c environment=prod` the bucket is retained and must be removed manually if no longer wanted.

## Scope

v0.4 does not add authentication, API keys, usage plans, family profiles, generated media, queues, multiplayer, or a production multi-environment platform. Route throttling is basic protection, not an identity boundary.

v0.8 adds only on-demand Polly question audio and controlled curated images in one private S3 bucket. It does not add AI image generation, uploads, external image URLs, speech recognition, SSML, streaming audio, queues/workflows, a CDN, a second Lambda/API, or a new DynamoDB table.

v0.5 adds only public hosting for the existing frontend. It does not add authentication/Cognito, family profiles (FASE 6), PWA features (FASE 7), audio/image generation (FASE 8), multiplayer/WebSockets (FASE 9), new game types (FASE 10), a custom purchased domain, or a CI/CD pipeline beyond Amplify's own GitHub build/deploy. The backend Lambda, its routes, DynamoDB tables, and the Bedrock integration are unchanged in contract.
