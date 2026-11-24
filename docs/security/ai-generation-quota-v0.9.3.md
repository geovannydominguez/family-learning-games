# v0.9.3 — AI Generation Daily Quota (operations)

Decision: `docs/architecture/ADR-021-ai-generation-daily-quota.md`.

## What it does

- `POST /games/generate` admits at most **20 requests per local day** (`America/Guayaquil`). This is a global limit, not a per-player one.
- A unit is reserved before any Bedrock call and is never returned. Failed generations count.
- When the quota is used up, the endpoint answers `429` with `AI_GENERATION_QUOTA_EXCEEDED` and `Retry-After`, and Bedrock is not invoked. The UI shows: "¡Por hoy ya creamos todos los juegos nuevos! 🌙 Mañana podrás crear más. Mientras tanto, puedes jugar los juegos que ya tienes." and disables the create button for that page session. There are no automatic retries.
- Existing games, single-player and multiplayer are unaffected.
- **It is not a dollar cap.** AWS Budgets and Cost Anomaly Detection (v0.9.1) remain the cost signals, and the v0.9.2 throttle (0.1 / 1) still applies.

## Configuration (CDK context, applied only when `aiGameGenerationEnabled=true`)

| Context key | Default | Lambda variable |
|---|---|---|
| `aiGenerationDailyLimit` | `20` (0..1000; `0` blocks generation) | `AI_GENERATION_DAILY_LIMIT` |
| `aiGenerationQuotaTimeZone` | `America/Guayaquil` | `AI_GENERATION_QUOTA_TIMEZONE` |
| (derived) multiplayer table name | `<env>-family-learning-games-multiplayer` | `AI_GENERATION_QUOTA_TABLE_NAME` |

The deploy command is the same as in v0.9.2. Omit the new keys to keep the defaults.

## Synthesized delta compared with v0.9.2

Generated with the production context (`aiGameGenerationEnabled=true`, Sonnet 4.6 model IDs, `allowedOrigins`):

- `BackendFunction`: new code asset, plus three environment variables (`AI_GENERATION_DAILY_LIMIT=20`, `AI_GENERATION_QUOTA_TABLE_NAME=Ref MultiplayerTable`, `AI_GENERATION_QUOTA_TIMEZONE=America/Guayaquil`).
- No resources added or removed. No IAM, API Gateway, Guardrail or table changes.

## Inspecting usage (read-only)

```bash
aws dynamodb get-item --table-name dev-family-learning-games-multiplayer \
  --key '{"PK":{"S":"QUOTA#AI_GENERATION"},"SK":{"S":"DAY#2026-11-13"}}' \
  --projection-expression "used, expiresAt"
```

The logs carry `AI_GAME_GENERATION_QUOTA_RESERVED` (with `quotaUsed`/`quotaLimit`/`quotaPeriod`) and `AI_GAME_GENERATION_QUOTA_EXHAUSTED`. A `500` on generation with `operation: reserve-ai-generation-quota` means the reservation failed and Bedrock was not called.

Emergency stop: redeploy with `-c aiGenerationDailyLimit=0` (or `aiGameGenerationEnabled=false`).

## Known limitations

- An abusive client can use up the day's quota (availability is denied for that day, but cost stays bounded).
- An ambiguous DynamoDB failure (every SDK attempt failed without a definite answer) fails closed and may lose one unit. Retries of an applied write never double-count.
- A request is counted even if it then fails (Bedrock error, Guardrail block, invalid content, or a failed save).
- The per-request bounds (5 rounds, `maxTokens` 4096/2048, the 28 s Lambda timeout and the execution budget) are what turn "games per day" into a bounded number of Bedrock calls.

## Post-deploy check (costs at most 1 generation)

1. With `-c aiGenerationDailyLimit=1`: one generation succeeds; a second returns `429 AI_GENERATION_QUOTA_EXCEEDED` with no `AI_GAME_GENERATION_ATTEMPT` log.
2. Redeploy with the default (20). Today's item keeps `used=1`, so 19 remain today.
