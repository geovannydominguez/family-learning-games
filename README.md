# Family Learning Games

Family Learning Games v0.4 keeps the durable ten-question quiz from v0.3 and adds explicit, on-demand game generation with Amazon Bedrock. The seeded-game flow remains available.

AI generation is **disabled by default**. Enabling it is an intentional deployment decision.

## Architecture

```text
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
    └── Repository ports → DynamoDB repositories → Games + GameSessions
```

The Domain and Application layers remain AWS-independent. The browser never receives AWS, model, Guardrail, prompt, or answer-key details. Generated content passes through a fixed product prompt, Bedrock Guardrail, deep application validation, and at most one content-only retry before it is stored.

## Local verification

```bash
npm install
npm test
npm run lint
npx tsc --noEmit
npm run build
npx cdk synth FamilyLearningGamesBackendStack
npx cdk synth FamilyLearningGamesBackendStack -c aiGameGenerationEnabled=true
```

Tests use injected clients and do not call live AWS services.

## CDK configuration

| Context key | Default | Purpose |
| --- | --- | --- |
| `environment` | `dev` | Prefix for physical resource names. |
| `frontendOrigin` | `http://localhost:3000` | Exact CORS origin. |
| `aiGameGenerationEnabled` | `false` | Opts the deployment into Bedrock generation. |
| `bedrockModelId` | `amazon.nova-micro-v1:0` | Converse model used only when AI is enabled. |
| `deploymentRegion` | `us-east-1` | Region for the complete stack, including Bedrock Runtime, its model ARN, and the Guardrail. |
| `generationThrottleRateLimit` | `1` | Rate limit for `POST /games/generate`, in requests/second. |
| `generationThrottleBurstLimit` | `2` | Burst limit for `POST /games/generate`. |

Boolean context values accept only `true` or `false`. Throttle values must be positive, and the burst limit must be an integer.
Choose one `<region>` for the deployment and repeat `-c deploymentRegion=<region>` on every CDK lifecycle command. Omitting it targets the default `us-east-1`, regardless of the AWS profile's configured region.

When AI is enabled, CDK provisions one family-safe Bedrock Guardrail and one published version. Lambda receives `BEDROCK_MODEL_ID`, `BEDROCK_REGION`, `BEDROCK_GUARDRAIL_ID`, and `BEDROCK_GUARDRAIL_VERSION`, uses a 28-second timeout, and receives resource-scoped `bedrock:InvokeModel`, `bedrock:ApplyGuardrail`, and Games-table `dynamodb:PutItem` permissions. `BEDROCK_REGION` is always the stack deployment region, so the Guardrail, Runtime client, and model ARN cannot be configured cross-region. Disabled deployments keep the 10-second timeout, cannot write to the Games table, and provision no Bedrock resources or permissions.

Generated candidates enforce these additional metadata limits before persistence: category ID 80 characters, category name 100, category description 300, category icon 16, question ID 80, answer ID 80, emoji 16, and image reference 2048. Every supplied field is trimmed and must remain non-empty; the existing title/question/answer limits remain 100/240/120.

Only `POST /games/generate` is throttled at the API stage. A `429` response is shown as a friendly retry-later message; the client and UI NEVER perform aggressive or automatic retries.

## Manual deployment

Replace `<aws-profile>` before copying these examples. The commands below are operational instructions; **none were executed while documenting v0.4**.

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
  -c bedrockModelId=amazon.nova-micro-v1:0 \
  -c deploymentRegion=<region> \
  -c generationThrottleRateLimit=1 \
  -c generationThrottleBurstLimit=2

npx cdk deploy FamilyLearningGamesBackendStack \
  --profile <aws-profile> \
  -c aiGameGenerationEnabled=true \
  -c bedrockModelId=amazon.nova-micro-v1:0 \
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

Generation-specific responses include `400` for invalid input, `409` for an ID collision, `422` for invalid generated content after the single retry, `429` for route throttling, `502` for a provider failure, and `503` when generation is disabled. Error bodies remain application-safe.

## Persistence, seed, and cost checks

DynamoDB table names follow:

```text
<environment>-family-learning-games-games
<environment>-family-learning-games-game-sessions
```

Seed the standard games after the first deploy or any destroy/redeploy:

```bash
AWS_PROFILE=<aws-profile> npm run seed:games -- \
  --table-name <GamesTableName>
```

Seeding restores the standard catalog only. It does not recreate AI-generated games or sessions.

Generation is synchronous and user-triggered, uses at most 4096 output tokens, retries at most once only for invalid generated content, and is route-throttled at 1 request/second with burst 2. Throttling is NOT authentication or a spend quota. After an enabled test:

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

The development tables use `RemovalPolicy.DESTROY`. Destroying the stack permanently deletes seeded/generated games, sessions, the API, Lambda, Guardrail, and managed logs; CDK bootstrap resources remain. A later deployment requires reseeding.

## Scope

v0.4 does not add authentication, API keys, usage plans, family profiles, generated media, queues, multiplayer, or a production multi-environment platform. Route throttling is basic protection, not an identity boundary.
