# Family Learning Games

Family Learning Games v0.3 keeps the complete ten-question family quiz and stores the game catalog and session progress durably in DynamoDB behind the AWS serverless API.

## Deployment quick guide

The repeatable lifecycle is:

```text
test → validate the target and infrastructure → deploy → verify → destroy → redeploy when needed
```

From the repository root:

```bash
# 1. Confirm the AWS account and region BEFORE changing resources.
aws sts get-caller-identity --profile gdominguez-admin
aws configure get region --profile gdominguez-admin

# 2. Test and validate locally.
npm test
npm run lint
npx tsc --noEmit
npm run build
npx cdk synth FamilyLearningGamesBackendStack --profile gdominguez-admin
npx cdk diff FamilyLearningGamesBackendStack --profile gdominguez-admin

# 3. Deploy and copy the ApiUrl and GamesTableName outputs.
npx cdk deploy FamilyLearningGamesBackendStack --profile gdominguez-admin

# 4. Seed the newly deployed Games table. Repeatable and safe to rerun.
AWS_PROFILE=gdominguez-admin npm run seed:games -- \
  --table-name <GamesTableName>
```

Then set the deployed `ApiUrl` in `.env.local`:

```dotenv
NEXT_PUBLIC_GAME_API_BASE_URL=https://your-api-id.execute-api.your-region.amazonaws.com
```

Restart `npm run dev` after changing `.env.local`, open [http://localhost:3000](http://localhost:3000), and complete the full flow:

```text
Home → player → category → difficulty → 10 questions → result
```

For a quick API check, replace the URL with the deployed `ApiUrl`:

```bash
curl --fail --show-error --silent \
  "https://your-api-id.execute-api.your-region.amazonaws.com/game-setup"
```

When the backend is no longer needed:

```bash
npx cdk destroy FamilyLearningGamesBackendStack \
  --profile gdominguez-admin
```

To use it again, run the validation commands and deploy the same stack:

```bash
npx cdk deploy FamilyLearningGamesBackendStack \
  --profile gdominguez-admin
```

> `FamilyLearningGamesBackendStack` is environment-agnostic. The selected AWS profile and region determine the target account and region, so ALWAYS verify both before deploy or destroy.

### First deployment only

Install dependencies and bootstrap CDK once per AWS account and region:

```bash
npm install
npx cdk bootstrap --profile gdominguez-admin
```

The AWS identity must have permission to bootstrap, deploy, and destroy the stack. If the application must be called from a different frontend origin, deploy with its exact origin:

```bash
npx cdk deploy FamilyLearningGamesBackendStack \
  --profile gdominguez-admin \
  -c frontendOrigin=https://family.example.com
```

CORS accepts that exact origin; include the scheme and omit a trailing slash. The default is `http://localhost:3000`.

### Operational notes

- Deployment prints `ApiUrl`, `FunctionName`, `GamesTableName` and `GameSessionsTableName`. Use `ApiUrl` as `NEXT_PUBLIC_GAME_API_BASE_URL` without adding an API route.
- Seed `GamesTableName` after the first deployment and after every destroy/redeploy cycle. The seed uses the standard AWS credential chain, so `AWS_PROFILE=gdominguez-admin` selects the intended credentials.
- `NEXT_PUBLIC_GAME_API_BASE_URL` is bundled into the browser client. Restart the development server or rebuild production after changing it.
- Games and sessions are stored in DynamoDB and survive Lambda recycling. The development tables use `RemovalPolicy.DESTROY`, so `cdk destroy` permanently deletes their data.
- `cdk destroy` removes the API, Lambda, DynamoDB tables, and its managed log group. It does not remove the CDK bootstrap resources.
- The stack can incur AWS charges while deployed. Destroy it when it is not needed, then verify in the AWS account that deletion completed.
- If the frontend reports a network error, first confirm the deployed `ApiUrl`, exact `frontendOrigin`, current AWS region, and that Next.js was restarted after editing `.env.local`.

If the API URL is missing at browser runtime, the UI shows an explicit, retryable configuration error; it never falls back to local data.

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
    ↓
GameRepository + GameSessionRepository
    ↓
DynamoDbGameRepository + DynamoDbGameSessionRepository
    ↓
Games table + GameSessions table
```

The browser neither imports the JSON dataset nor creates local repositories. AWS, Lambda, API Gateway and HTTP types remain outside the domain and application rules. Scoring, random selection, answer validation and progression reuse the v0.1 game logic.

## HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/games` | Lists seeded games without exposing answer keys. |
| `GET` | `/games/{gameId}` | Gets one seeded game without exposing answer keys. |
| `GET` | `/game-setup` | Returns players, categories and difficulties; never questions or answer keys. |
| `POST` | `/game-sessions` | Starts a ten-question session from `playerId`, `categoryId` and `difficulty`. |
| `GET` | `/game-sessions/{sessionId}` | Retrieves durable progress for an existing session. |
| `POST` | `/game-sessions/{sessionId}/answers` | Submits `answerId`, advances on the backend and returns feedback plus the next public session. |

A start response uses `201`. Errors use a stable envelope:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Game session was not found or has expired."
  }
}
```

Invalid input is `400`, missing resources or sessions are `404`, invalid or concurrently changed session state is `409`, and unexpected failures are safe `500` responses without stack traces.

## Durable persistence and seed

The deployed Lambda reads games only from the `Games` table and stores sessions only in the `GameSessions` table. The JSON file remains a development seed input, not a runtime fallback. Session writes use a revision condition so duplicate or stale answer requests cannot advance a session twice.

To seed using environment configuration instead of a CLI flag:

```bash
AWS_PROFILE=gdominguez-admin \
GAMES_TABLE_NAME=<GamesTableName> \
npm run seed:games
```

## Infrastructure

`FamilyLearningGamesBackendStack` defines only:

- one Node.js 22 Lambda function;
- one API Gateway HTTP API with six routes;
- one on-demand DynamoDB `Games` table keyed by `gameId`;
- one on-demand DynamoDB `GameSessions` table keyed by `sessionId`;
- table-scoped Lambda IAM access (`GetItem`/`Scan` for games and `GetItem`/`PutItem`/`UpdateItem` for sessions);
- Lambda table-name environment variables;
- a seven-day CloudWatch log group;
- the minimal Lambda execution permissions generated by CDK;
- CORS for the `frontendOrigin` CDK context (default `http://localhost:3000`);
- `ApiUrl` and `FunctionName` outputs.

Override the deployment origin when needed:

```bash
npx cdk deploy -c frontendOrigin=https://family.example.com
```

The Lambda emits one structured JSON record per request with `level`, `timestamp`, `requestId`, `method`, `path`, `statusCode` and `durationMs`.

## Verification

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
npx cdk synth
```

Tests execute domain/application logic, DynamoDB mapping/conditional behavior, repositories, the HTTP router and API client without a live AWS account. CDK assertions validate the resource boundary.

## Scope boundaries

v0.3 intentionally excludes authentication, user accounts, family profiles, Cognito, AI, generated media, audio, multiplayer, WebSockets, queues, event buses, relational databases, microservices, CQRS and global frontend state libraries.
