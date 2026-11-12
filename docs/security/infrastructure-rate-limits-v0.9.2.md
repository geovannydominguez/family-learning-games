# Family Learning Games — Infrastructure Rate Limits v0.9.2

**Project:** Family JOAM Games
**Application:** Family Learning Games
**Version:** v0.9.2
**Release name:** Infrastructure Rate Limits
**Date:** 2026-11-12
**Environment:** Production (`environment=dev` resource prefix, see §2)
**AWS account / region:** `089826257584` / `us-east-1`
**Status:** IMPLEMENTED LOCALLY — VALIDATED LOCALLY — **NOT DEPLOYED** (backend and frontend). **No approval exists yet to execute any AWS change** (backup, change set or deployment).

---

## 1. Objective

Bound the request rates that reach the shared backend Lambda, DynamoDB and the paid AI path, and protect the family data tables against accidental deletion, using only AWS CDK and no new AWS services.

This release builds on the v0.9.1 baseline (`minimum-security-baseline-v0.9.1.md`) and on the v0.9.2 diagnostics (findings F-01 … F-14).

**Important:** none of these controls is a spending cap. API Gateway throttling and DynamoDB maximum throughput limit *rates*. They are aggregate, not per client, so one abusive client can use up the shared budget and deny service to the family. They do not guarantee a maximum number of concurrent or daily generations. AWS Budgets and Cost Anomaly Detection (v0.9.1) remain the cost signals.

Out of scope, unchanged: Cognito, WAF, JWT, Lambda authorizers, game logic, Bedrock/Polly business quotas (v0.9.3).

## 2. Current architecture (verified 2026-11-12)

| Component | Resource |
|---|---|
| Stack | `FamilyLearningGamesBackendStack` (CDK v2, `aws-cdk-lib` 2.267.0) |
| HTTP API | `family-learning-games-api` (`qkyddcomyj`), stage `$default`, 14 routes, no authorizers |
| WebSocket API | `family-learning-games-multiplayer` (`vd9aqlptji`), stage `production`, 9 routes, no authorizer |
| Lambda | `family-learning-games-backend` (Node 22, 256 MB, 28 s, AI enabled), serves HTTP + WebSocket + AI |
| DynamoDB | `dev-family-learning-games-{games,game-sessions,players,multiplayer}`, on-demand, no GSIs |
| Lambda account quota | **10** concurrent executions (`UnreservedConcurrentExecutions` 10) |

The production context was reconstructed from the deployed CloudFormation template. The deployed template was **identical** to a local synthesis of the pre-v0.9.2 HEAD with this context; the only difference was the Lambda asset path in source-map metadata.

```text
-c deploymentRegion=us-east-1 -c environment=dev
-c allowedOrigins=https://play.joamgames.com
-c aiGameGenerationEnabled=true
-c bedrockGeneratorModelId=global.anthropic.claude-sonnet-4-6
-c bedrockValidatorModelId=global.anthropic.claude-sonnet-4-6
-c audioCacheVersion=v1 -c audioCacheExpirationDays=30 -c multiplayerMaxPlayers=8
```

`environment=dev` is the production prefix. Changing it renames, and therefore **replaces**, every table.

## 3. Implemented configuration

All values live in `infra/lib/rateLimits.ts` (typed, validated, with the defaults below). One optional CDK context key, `rateLimits` (a JSON object, partial), overrides any subset. `POST /games/generate` keeps its pre-existing keys `generationThrottleRateLimit` / `generationThrottleBurstLimit`. One boolean, `tableDeletionProtection` (default `true`), controls table protection.

```bash
# example override (not needed for production)
-c rateLimits='{"webSocket":{"rateLimit":30},"tables":{"multiplayer":{"maxWriteRequestUnits":400}}}'
```

Validation: rates are positive and ≤ 10,000 (fractions allowed). Bursts and request units are integers between 1 and 5,000 / 40,000. Unknown keys and invalid JSON fail synthesis.

### 3.1 HTTP API (`$default` stage)

| Scope | Rate (req/s) | Burst | Status |
|---|---:|---:|---|
| Stage default (all other routes) | 10 | 20 | approved |
| `POST /games/generate` | **0.1** | **1** | approved (was 1 / 2) |
| `POST /games/{gameId}/questions/{questionId}/audio` | 2 | 10 | approved |
| `POST /multiplayer/rooms` | 1 | 5 | approved |
| `POST /multiplayer/rooms/{roomCode}/join` | 2 | 10 | approved |

- Route keys are checked at synthesis against the routes actually created. The stage `DependsOn` every overridden route.
- `0.1` is synthesized unchanged (CloudFormation type Double). API Gateway acceptance of a fractional rate is verified only at deploy time. If it were rejected, the stack update fails and CloudFormation rolls back automatically.
- **Players CRUD** (`GET/POST /players`, `PUT/DELETE /players/{playerId}`) gets no override. Each request is one Scan of a 10-item table or one item write, and the stage default covers family use. The same applies to `GET /game-setup`, `GET /games` and the session routes.

### 3.2 WebSocket API (`production` stage)

| Scope | Rate (msg/s) | Burst | Status |
|---|---:|---:|---|
| Stage default (all 9 routes, including `$connect`) | 20 | 40 | approved |

Routes, integrations, authorization and `autoDeploy` are unchanged. Server-to-client `postToConnection` traffic is the Management API: it is not counted by stage throttling, although it does appear in the `MessageCount` metric.

**Sizing for an 8-player room** (from the message inventory and metrics):

- Per question each player sends one `SUBMIT_ANSWER`. At the deadline every client also sends `QUESTION_TIMEOUT`, repeated every 3 s while the question stays OPEN. Peak is about 16 messages within roughly 1 s, plus one `NEXT_QUESTION`.
- Start of game: 8 `IDENTIFY`. Reconnects back off from 1 s to 10 s.
- Observed (2026-11-07 session): 60 `QUESTION_TIMEOUT` and 55 `SUBMIT_ANSWER` in total, p95 handler time 350–720 ms, peak 6 concurrent Lambda executions, 0 errors or throttles.
- Burst 40 absorbs two rooms hitting a deadline in the same second. Rate 20 stays below the Lambda capacity: 10 concurrent executions ÷ about 0.35–0.7 s ≈ 14–28 invocations/s.

### 3.3 DynamoDB maximum on-demand throughput — CANDIDATES

| Table | Max read RU/s | Max write RU/s | Observed peak hour (sum) |
|---|---:|---:|---|
| `dev-family-learning-games-games` | 200 | 20 | 435 RRU / 4 WRU |
| `dev-family-learning-games-game-sessions` | 50 | 50 | 2 RRU / 12 WRU |
| `dev-family-learning-games-players` | 50 | 20 | 81 RRU / 8 WRU |
| `dev-family-learning-games-multiplayer` | 600 | 300 | 1,007 RRU / 581 WRU |

**These values are candidates, pending validation (§9.2).** The available metrics are hourly sums. Per-second peaks are still unknown. The code-level estimate for one 8-player room is about 120 RRU/s and about 50 WRU/s at a question's last answer:

- `recordAnswer` is a 2-item transaction, 4 WRU.
- The reveal transaction is up to 9 items, about 18 WRU.
- Gate reads are strongly consistent.

That is well below the candidates, so legitimate transactions should not be throttled. Validate before production:

```bash
for M in ConsumedReadCapacityUnits ConsumedWriteCapacityUnits; do
aws cloudwatch get-metric-statistics --profile <project-profile> --region us-east-1 --namespace AWS/DynamoDB \
  --metric-name $M --dimensions Name=TableName,Value=dev-family-learning-games-multiplayer \
  --start-time 2026-11-08T00:00:00Z --end-time 2026-11-08T02:00:00Z --period 60 --statistics Sum \
  --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text; done   # divide each Sum by 60
```

Names, key schemas, billing mode (`PAY_PER_REQUEST`) and indexes (none) are unchanged.

### 3.4 Application hardening (no game-logic change)

- **WebSocket gateway errors (F-06).** `MultiplayerSocketClient` reports frames without `type` but with a `message` (API Gateway/Lambda errors such as `Too Many Requests`) through `onTransportError`. It no longer drops them silently.
- **Unconfirmed answers (F-06).** An answer is *pending* until `ANSWER_ACCEPTED`, or an own `ROOM_STATE` with `currentAnswerId`, confirms it. The UI shows "Enviando respuesta…" and only shows "Respuesta enviada 🔒" after confirmation.
  - An `ERROR` for that request unlocks the options.
  - Without confirmation after 5 s, exactly one `SYNC_ROOM` is requested.
  - If the snapshot shows no answer, or if no reply arrives within another 5 s, the options unlock with a notice so the player can choose again.
  - `SUBMIT_ANSWER` is **never** resent automatically, and `SYNC_ROOM` is rate-limited to one per 5 s.
  - Server idempotency (one answer per room/question/player) is unchanged.
  - Every notice carries the `questionId` it is about (`null` for connection notices). After *every* server event, an answer notice is cleared when that answer is confirmed, another question is current, or the room is no longer `IN_PROGRESS`.
  - Only an own `ROOM_STATE` that was actually applied (version ≥ current) can resolve a pending answer. Both rules come from the pre-production review (§13).
- **Transaction retry (F-07).** `DynamoDbMultiplayerRepository` retries a `TransactionCanceledException` at most twice (25 ms / 50 ms plus jitter), and only when every non-`None` cancellation reason is transient (`TransactionConflict`, `ThrottlingError`, `ProvisionedThroughputExceeded`, `RequestLimitExceeded`) and no `ConditionalCheckFailed` is present.
  - A cancelled transaction applies nothing, and conditions are re-evaluated on retry, so exactly-once answer, reveal and membership semantics are preserved.
  - `TransactionConflict` can occur legitimately when several answers update the same room item concurrently.
  - Before this change, such a conflict surfaced as `UNEXPECTED_ERROR`.
- **HTTP 429 (F-13).** Only `POST /games/generate` maps to `RATE_LIMITED`, with the game-creation message. Any other 429 maps to `REQUEST_THROTTLED` with a generic "Hay muchas solicitudes…" message. There is no automatic retry.

## 4. Values and justification summary

| Control | Value | Basis |
|---|---|---|
| Generation throttle | 0.1 / 1 | A generation holds a Lambda execution for about 18 s (observed 17.5 s and 18.4 s). At 1 rps it could fill all 10 executions. At 0.1 rps the steady state is about 2. *Not a guarantee*: the token bucket is approximate and other paths share the quota. |
| HTTP default | 10 / 20 | Busiest observed hour: 146 requests. App load is about 3 GETs per device. |
| Audio | 2 / 10 | One tap per question per device; Polly is used only on a cache miss. |
| Create / join room | 1 / 5, 2 / 10 | One room per game, up to 8 joins in a few seconds. Observed: 7 joins with 201 and 19 with 409. |
| WebSocket | 20 / 40 | §3.2 |
| Tables | candidates | §3.3 |

## 5. Decision: no Lambda reserved concurrency

**The regional Lambda concurrency quota is 10, and v0.9.2 configures no Reserved Concurrency.**


The regional quota is 10 concurrent executions, and AWS requires 100 to remain unreserved, so no positive reserved concurrency can be set. No quota increase was requested. The quota itself is the effective cap, **shared** by HTTP, WebSocket, AI generation and any other Lambda in the account/region.

Remaining risk: AI generation and multiplayer compete for the same 10 executions. The generation route throttle (0.1 / 1) is the mitigation. Lambda throttling would surface as HTTP 5xx or WebSocket gateway error frames, and the latter are now reported to the player (§3.4).

## 6. Data protection

Before v0.9.2 the four tables had `DeletionPolicy: Delete`, no deletion protection, no PITR and no backups. Termination protection was off.

| Option | What it does | Change type |
|---|---|---|
| `RemovalPolicy.RETAIN` (`DeletionPolicy`/`UpdateReplacePolicy: Retain`) | If CloudFormation would delete the table (stack deletion, logical-ID change, replacement), the table is kept and orphaned instead. | Template attribute, no resource update |
| `deletionProtection` (`DeletionProtectionEnabled: true`) | `DeleteTable` fails for **any** caller (console, CLI, CloudFormation) until it is disabled. | In-place, no interruption |

v0.9.2 enables **both** by default (`tableDeletionProtection=true`). `-c tableDeletionProtection=false` restores the old behaviour for disposable stacks.

**Not changed (decisions pending):**

- **PITR.** Not enabled. Its cost is proportional to table size: about 100 KB today, so negligible, but recurring and growing. Pending approval.
- **Media bucket.** It stays `Delete` + `autoDeleteObjects` because `environment=dev`. Switching it to RETAIN removes the `Custom::S3AutoDeleteObjects` resource. Whether that removal can empty the bucket must be verified on a disposable stack first. The bucket holds curated images (`images/`) and regenerable audio (`audio-cache/`).

**A manual on-demand backup of the four tables is required before the deployment** (§9).

## 7. Remaining risks

1. Limits are aggregate. A direct client can use up the HTTP, WebSocket or generation budget and deny service to the family (no WAF or authentication, by scope).
2. The Lambda concurrency quota (10) is shared; AI can still briefly compete with gameplay. No Reserved Concurrency is configured.
3. DynamoDB values are **candidates** until per-minute peaks are checked (§9.2). The `Games` read maximum (200) must be revisited as the catalog grows: `GET /game-setup` and `GET /games` are full Scans.
4. Whether API Gateway includes CORS headers on throttled 429 responses is unverified. Without them, the browser reports a network error instead of `REQUEST_THROTTLED`.
5. If eight devices load the app at the same instant, they can exceed the HTTP burst. The result is a generic retry message; there is no automatic retry.
6. WebSocket reconnect attempts are unbounded (backoff from 1 s to 10 s); under `$connect` throttling a client retries at most every 10 s.
7. Known, harmless race: a gateway error caused by *another* message can trigger a `SYNC_ROOM` that is processed before a concurrent `SUBMIT_ANSWER` commits. The options unlock with a notice; the late `ANSWER_ACCEPTED` then confirms the answer and clears the notice. A second click receives `ANSWER_ALREADY_SUBMITTED`. No answer is lost or double-scored.
8. Pre-existing (not v0.9.2): if the SDK retries a `TransactWriteItems` after a network timeout of a committed transaction, it can report a false "duplicate". `ClientRequestToken` would address it (v0.9.3).
9. Bedrock and Polly have no business quotas (v0.9.3).
10. The media bucket has no retention (§6).

### 7.1 Checks that can only happen after deployment

- API Gateway accepts the fractional generation rate `0.1`.
- Whether WebSocket stage throttling also counts `$connect`.
- The real frame a client receives for a throttled WebSocket message (the client handles `{"message": …}` frames).
- Whether HTTP 429 responses carry CORS headers.
- No Lambda, API or DynamoDB throttling during real family games.
- Amplify password protection still active after the frontend publication.

## 8. Tests executed (local, 2026-11-12)

| Validation | Result |
|---|---|
| `npm run lint` | pass |
| `npx tsc --noEmit` | pass |
| `npm test` | **423 / 423 pass** (411 + 12 pre-production regression tests) |
| `npm run build` | pass |
| `npx cdk synth` with the production context (AWS credentials disabled) | pass |
| `npx cdk diff --template <deployed-template.json>` with the production context (template method, no change set, credentials disabled) | only the expected changes (below); identical before and after the frontend fix |
| `git diff --check` | pass |

New or updated tests:

- **CDK:** HTTP default and route throttling with real route keys, a fractional rate, WebSocket stage throttling, per-table maximum throughput, logical IDs/keys/billing unchanged, Retain + deletion protection, no reserved concurrency, `rateLimits` validation, generation rollback keys.
- **Repository:** transient retry bounds, no retry on business or validation errors.
- **HTTP client and UI:** 429 mapping.
- **WebSocket client:** gateway error frames.
- **Reducer:** pending, confirmed, rejected, timeout, resync and reveal cases.
- **Pre-production regression (§13):**
  - original repro (notice bound to its question);
  - pending → ACK; pending → own snapshot;
  - timeout → late ACK; timeout → late snapshot;
  - gateway-error race with a late ACK;
  - new question clears the previous notice;
  - game finished clears notices (podium);
  - gateway error while pending (one `SYNC_ROOM` only);
  - duplicate confirmation;
  - ACK for a previous question never confirms the new one;
  - out-of-order older snapshot never unlocks;
  - connection notices and server errors of other operations are preserved.

**Expected CloudFormation changes** (against the deployed template):

| Resource | Change |
|---|---|
| 4 × `AWS::DynamoDB::Table` | `+ DeletionProtectionEnabled: true`, `+ OnDemandThroughput`, `DeletionPolicy`/`UpdateReplacePolicy` Delete → Retain |
| `MultiplayerWebSocketStage` | `+ DefaultRouteSettings` 20 / 40 |
| `BackendApi/DefaultStage` | `+ DefaultRouteSettings` 10 / 20; generate 1 / 2 → 0.1 / 1; 3 route overrides added; `DependsOn` 3 routes added |
| `BackendFunction` | `Code` (new asset: repository retry) |

No resource is added, removed or replaced. There are no IAM, CORS, environment, Guardrail or route changes. Table name, `KeySchema`, `AttributeDefinitions`, billing mode and TTL are identical for all four tables. **If a future diff or change set shows any replacement or deletion, stop.**

## 9. Deployment plan (account owner; requires explicit approval; nothing here has been executed)

Shell variables: `P=<project-profile>`, `R=us-east-1`. `CTX` is the production context from §2:

```bash
-c deploymentRegion=us-east-1 -c environment=dev -c allowedOrigins=https://play.joamgames.com \
-c aiGameGenerationEnabled=true \
-c bedrockGeneratorModelId=global.anthropic.claude-sonnet-4-6 \
-c bedrockValidatorModelId=global.anthropic.claude-sonnet-4-6 \
-c audioCacheVersion=v1 -c audioCacheExpirationDays=30 -c multiplayerMaxPlayers=8
```

**Do not pass `generationThrottleRateLimit` / `generationThrottleBurstLimit`**: that would keep the old generation limits. Deploy from a committed tree so the repository matches production.

### 9.1 Identity

```bash
aws sts get-caller-identity --profile $P --query Account --output text   # must print 089826257584
```

### 9.2 DynamoDB per-minute metrics (read-only; required to consolidate §3.3)

CloudWatch keeps 1-minute datapoints for 15 days. The only real multiplayer session (2026-11-08 00:00–02:00 UTC) remains available at 1-minute resolution until about **2026-11-23**, and only at 5-minute resolution after that. These are per-minute sums; they are not evidence of per-second capacity.

```bash
for T in games players multiplayer game-sessions; do for M in ConsumedReadCapacityUnits ConsumedWriteCapacityUnits; do
  echo "== $T $M (max per-minute sum)"
  aws cloudwatch get-metric-statistics --profile $P --region $R --namespace AWS/DynamoDB --metric-name $M \
    --dimensions Name=TableName,Value=dev-family-learning-games-$T \
    --start-time 2026-11-08T00:00:00Z --end-time 2026-11-08T02:00:00Z --period 60 --statistics Sum \
    --query 'max_by(Datapoints,&Sum).[Timestamp,Sum]' --output text
done; done
```

Divide each per-minute sum by 60 to get the average RU/s in that minute. If the average in any minute exceeds about 30 % of a candidate maximum, raise that maximum with `-c rateLimits='{"tables":{…}}'` before deploying.

### 9.3 On-demand backup (creates AWS resources: requires approval)

```bash
STAMP=$(date -u +%Y%m%dT%H%MZ)
for T in games game-sessions players multiplayer; do
  aws dynamodb create-backup --profile $P --region $R \
    --table-name dev-family-learning-games-$T --backup-name pre-v092-$T-$STAMP \
    --query 'BackupDetails.[BackupName,BackupStatus]' --output text
done
aws dynamodb list-backups --profile $P --region $R \
  --query "BackupSummaries[?starts_with(BackupName,'pre-v092')].[TableName,BackupStatus,BackupSizeBytes]" --output table
```

Proceed only when all four are `AVAILABLE`. Also save the current stage settings for the rollback:

```bash
aws apigatewayv2 get-stage --profile $P --region $R --api-id qkyddcomyj --stage-name '$default' > pre-v092-http-stage.json
aws apigatewayv2 get-stage --profile $P --region $R --api-id vd9aqlptji --stage-name production > pre-v092-ws-stage.json
```

### 9.4 Mandatory change-set review before execution

```bash
# 1. Create, do not execute (uploads the Lambda asset to the CDK bootstrap bucket).
npx cdk deploy FamilyLearningGamesBackendStack --profile $P $CTX --no-execute --change-set-name v092-rate-limits
# 2. Review: exactly 7 rows, all Action=Modify and Replacement=False
#    (4 tables, 2 stages, BackendFunction).
aws cloudformation describe-change-set --profile $P --region $R --stack-name FamilyLearningGamesBackendStack \
  --change-set-name v092-rate-limits --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output table
# 3a. Anything else (Add, Remove, Replacement True/Conditional, another resource): delete it and stop.
aws cloudformation delete-change-set --profile $P --region $R --stack-name FamilyLearningGamesBackendStack --change-set-name v092-rate-limits
# 3b. Otherwise execute and wait.
aws cloudformation execute-change-set --profile $P --region $R --stack-name FamilyLearningGamesBackendStack --change-set-name v092-rate-limits
aws cloudformation wait stack-update-complete --profile $P --region $R --stack-name FamilyLearningGamesBackendStack
```

### 9.5 Backend verification and smoke tests

1. `aws apigatewayv2 get-stage` on both stages: 10/20 and the four route overrides; 20/40 on WebSocket.
2. `aws dynamodb describe-table --query 'Table.[OnDemandThroughput,DeletionProtectionEnabled]'` on the four tables.
3. On `https://play.joamgames.com`:
   - load the app;
   - one single-player game;
   - the audio of one question;
   - one multiplayer game on 2+ devices: join, answers, timeout, next question, podium, and one reconnect (switch tab or network);
   - one AI generation.

   Optional: a second generation immediately after should return 429 with the game-creation message. It costs one Bedrock call.
4. Monitor for 24 h, then 7 days:
   - Lambda `Throttles` / `Errors`;
   - HTTP 4xx/5xx;
   - WebSocket `ClientError` / `ExecutionError`;
   - DynamoDB `ThrottledRequests`;
   - logs for `UNEXPECTED_ERROR` and `TransactionCanceledException`.

### 9.6 Frontend publication (Amplify) — password protection

The frontend reaches production only through Amplify's build of `main`. It is compatible in both orders:

- **New frontend + old backend:** client-only changes, works.
- **Old frontend + new backend:** works; it shows the old 429 copy and keeps the v0.9.0 answer-lock behaviour.

The recommended order is backend first, then frontend.

Amplify password protection is a **branch setting** (`enableBasicAuth`) of app `dkl9nrhb7btm1`, not repository content. `amplify.yml`, `public/`, `next.config.ts` and the Amplify environment variables are unchanged by v0.9.2. Access control is configured for `main` only ("Manage access for all branches: Disabled"), so **another branch deployed by Amplify would be public**. Before pushing, check with read-only queries that never print `basicAuthCredentials`:

```bash
aws amplify get-app --profile $P --region $R --app-id dkl9nrhb7btm1 \
  --query 'app.{autoBranchCreation:enableAutoBranchCreation,patterns:autoBranchCreationPatterns}'
aws amplify get-branch --profile $P --region $R --app-id dkl9nrhb7btm1 --branch-name main \
  --query 'branch.{basicAuth:enableBasicAuth,pullRequestPreview:enablePullRequestPreview,autoBuild:enableAutoBuild,env:environmentVariables}'
aws amplify list-branches --profile $P --region $R --app-id dkl9nrhb7btm1 --query 'branches[].[branchName,enableBasicAuth]' --output table
```

Expected: `basicAuth: true` on `main`, no automatic branch creation and no pull-request previews (or, if enabled, protected). Publish only by pushing to `main`. After the Amplify build, open the site in a private window and confirm the password prompt; then repeat the §9.5 multiplayer smoke test.

The Service Worker caches only hashed `/_next/static/` assets and `/icons/`, and navigations go to the network, so clients (including the installed PWA) pick up the new frontend on their next navigation without a `CACHE_VERSION` bump.

## 10. Rollback plan

- **Failed deployment:** CloudFormation rolls back automatically, including a rejection of the fractional rate.
- **Throttling too strict:**
  - Redeploy with a `rateLimits` override, for example `-c rateLimits='{"webSocket":{"rateLimit":100,"burstLimit":200}}'`.
  - For generation, use `-c generationThrottleRateLimit=1 -c generationThrottleBurstLimit=2`.
- **DynamoDB throttling:** raise the table maxima through `rateLimits.tables`, for example `{"tables":{"multiplayer":{"maxReadRequestUnits":4000,"maxWriteRequestUnits":2000}}}`. Prefer explicit high values over deleting the property: whether removing `OnDemandThroughput` from the template clears it is unverified.
- **Emergency (CLI), then reconcile with `cdk deploy` using the same values:**
  - `aws apigatewayv2 update-stage --api-id … --stage-name … --default-route-settings ThrottlingRateLimit=…,ThrottlingBurstLimit=…`;
  - `aws dynamodb update-table --table-name … --on-demand-throughput MaxReadRequestUnits=-1,MaxWriteRequestUnits=-1` (`-1` removes the maximum; confirm before relying on it).
- **Full code rollback:** redeploy the previous commit with the §2 context. Its `Delete` policy is only a template change. Deletion protection stays enabled on the tables until it is disabled explicitly, which is the safe direction. Prefer a forward fix.
- **Frontend:** redeploy the previous build from the Amplify console, or push a revert to `main`.
- **Data:** `restore-table-from-backup` from the §9.3 backups. It creates a new table, so a rename/cut-over decision is required.

## 11. Acceptance criteria

| ID | Criterion | Result |
|---|---|---|
| AC-01 | HTTP stage default and route throttling defined in CDK with real route keys | PASS (local) |
| AC-02 | Generation throttle 0.1 / 1 synthesized without rounding | PASS (local); deploy acceptance pending |
| AC-03 | WebSocket stage throttling 20 / 40, routes unchanged | PASS (local) |
| AC-04 | DynamoDB maximum throughput on the four tables, keys/billing unchanged | PASS (local); values are candidates |
| AC-05 | Tables retained and deletion-protected with in-place changes only | PASS (local diff) |
| AC-06 | No reserved concurrency; decision documented | PASS |
| AC-07 | WebSocket gateway errors surfaced; unconfirmed answers never shown as accepted; no automatic resend | PASS (unit tests) |
| AC-08 | Transient transaction cancellations retried with a bound, business conflicts not retried | PASS (unit tests) |
| AC-09 | 429 mapped per route | PASS (unit tests) |
| AC-10 | Template diff limited to the expected resources, no replacement/deletion | PASS (local) |
| AC-11 | Pre-deploy backup taken and `AVAILABLE` | PENDING (requires approval) |
| AC-11b | Change set reviewed: 7 × Modify, Replacement False | PENDING (requires approval) |
| AC-11c | DynamoDB per-minute metrics reviewed; candidates consolidated or adjusted | PENDING |
| AC-11d | Amplify branches/previews checked; `main` still password-protected after publication | PENDING |
| AC-13 | Answer notices never outlive their question; stale snapshots never unlock | PASS (unit tests, §13) |
| AC-12 | Deployed and validated in production (multiplayer, single player, AI, audio) | PENDING |

## 12. Pending for v0.9.3

- Bedrock and Polly business quotas (per day, per player, global); reconsider whether AI generation stays enabled by default.
- Per-connection/per-member WebSocket rate limits; closing connections that never `IDENTIFY`.
- `GET /players` enumeration combined with joining by room code.
- Verify CORS headers on throttled 429s.
- Validate the DynamoDB candidates with per-minute metrics and consolidate them.
- Decisions on PITR and media-bucket retention.
- Optional CloudWatch alarms on throttling (small recurring cost).
- `package.json` version and release notes.

## 13. Pre-production review (2026-11-12)

### 13.1 Defect: stale answer notices (frontend NO-GO, now fixed)

- **Symptom:** after an unconfirmed answer was unlocked ("No pudimos confirmar tu respuesta…"), the notice stayed visible:
  - after a late `ANSWER_ACCEPTED` or snapshot confirmed the answer, next to "Respuesta enviada 🔒";
  - on the following questions;
  - on the podium.
- **Root cause:** `notice` was a plain string with no link to a question, and it was only reconsidered inside `resolvePendingAnswer` while an answer was still pending. Once the pending answer was resolved, nothing ever cleared the notice.
- **Fix:** `MultiplayerNotice { message, questionId }`, plus `clearStaleAnswerNotice` after every server event:
  - an answer notice is cleared when that question's answer is confirmed, another question is current, or the room is not `IN_PROGRESS`;
  - connection notices (`questionId: null`) and server errors are untouched;
  - a new answer clears only answer notices.

### 13.2 Defect found by the new tests: out-of-order snapshot unlocked a pending answer (fixed)

- **Symptom:** an own `ROOM_STATE` with an older version arriving out of order was ignored for the room, but `resolvePendingAnswer` still treated it as the recovery snapshot and unlocked the current question's pending answer.
- **Fix:** an own snapshot is authoritative only if it was applied (`event.version >= state.version`).

### 13.3 Unchanged guarantees

- No new retries.
- `SUBMIT_ANSWER` is never resent.
- At most one recovery `SYNC_ROOM` per answer, plus at most one per 5 s for gateway errors.
- Scoring and server idempotency are unchanged.
- CloudFormation diff unchanged: the fix is frontend-only.

### 13.4 Verdict

| Area | Verdict |
|---|---|
| Local implementation (backend + frontend) | complete; all validations pass |
| Start the deployment procedure (§9) | **GO**, subject to explicit approval of the AWS steps and the gates in §9.2–§9.4 and §9.6 |
| Production release v0.9.2 | pending: AC-11 … AC-12 |
