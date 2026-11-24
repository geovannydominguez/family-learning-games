# ADR-021 — Global Daily Quota for AI Game Generation

- **Status:** Accepted
- **Date:** 2026-11-13
- **Phase:** FASE 9 — Multiplayer (v0.9.3 cost protection)
- **Version:** v0.9.3

## Context

`POST /games/generate` calls Amazon Bedrock (Claude Sonnet 4.6) for the Generator and the Validator. The v0.9.2 route throttle (rate 0.1 / burst 1) limits the request *rate*, not the total. In theory it still admits about 8,640 requests per day. The API is publicly reachable even though the Amplify frontend is password protected, and `playerId` gives no protection: `GET /players` lists the IDs and `POST /players` creates players without limit. AWS Budgets and Cost Anomaly Detection only send alerts, and they arrive late.

Each admitted request is already bounded inside the backend:

- at most 5 repair rounds;
- per round, at most 2 generator calls and 1 validator call;
- `maxTokens` of 4096 (generator) and 2048 (validator);
- the ADR-015 execution budget inside a 28 s Lambda.

In practice that is about 4–5 `Converse` calls per request, with a logical ceiling of 15.

Native AWS options were evaluated and rejected:

- usage plans and API keys exist only for REST APIs;
- WAF cannot be attached to an HTTP API;
- reserved concurrency is impossible with the account quota of 10;
- Bedrock service quotas are account-wide rate limits, not daily limits.

## Decision

1. **One global quota, counted per local day.**
   - Default: 20 admitted generation requests per day.
   - The day is a calendar day in `America/Guayaquil`, computed with `Intl` (IANA, DST-aware).
   - The quota is global by design. No client identifier takes part in it.
2. **What is counted: admitted requests.**
   - One unit is reserved after the cheap checks (enabled, request shape, player lookup) and **before the first Bedrock call**.
   - Units are **never returned**: a failed generation also spent tokens, and returning units would let induced failures bypass the limit.
   - Tokens and individual invocations are not counted. The per-request bounds above already cap invocations per admitted request.
3. **Persistence: the existing multiplayer table.** No new table and no IAM change; the Lambda already has `UpdateItem` on this table.
   - Item: `PK = QUOTA#AI_GENERATION`, `SK = DAY#YYYY-MM-DD`.
   - Attributes: `used` (N), `reservations` (SS), `expiresAt` (N, the table's TTL attribute), `entityType`.
   - The item is reachable only through keys the server builds; no client-supplied key can reach it. It does not appear in any Scan.
   - Every new day is a **new item**. TTL is cleanup only, and admission never depends on it.
4. **One conditional `UpdateItem`:**
   - `ADD used :1, reservations {id}`
   - condition: `(attribute_not_exists(used) OR used < :limit) AND NOT contains(reservations, :id)`
   - `ReturnValuesOnConditionCheckFailure = ALL_OLD`

   DynamoDB serializes writes to one item, so concurrent requests never exceed the limit. The first write of the day creates the item.
5. **Protection against SDK retries.**
   - Each call carries a fresh random `reservationId`.
   - If the SDK resends a request that was already applied (its response was lost), the resend fails the `NOT contains` condition. The returned old item contains the ID, so the call is reported as reserved, without a second increment.
   - Result: **at most one unit per call**. A unit test runs this through the real SDK v3 retry middleware.
   - If the outcome stays ambiguous after every SDK attempt, the error propagates: the request fails closed (HTTP 500), Bedrock is not invoked, and **one unit may be lost**. Exactly-once is not claimed.
6. **HTTP.**
   - Status `429`, envelope `{ "error": { "code": "AI_GENERATION_QUOTA_EXCEEDED", "message": "…" } }` (the existing envelope), plus a `Retry-After` header with the seconds until local midnight.
   - Any other DynamoDB failure maps to the existing `500` persistence path.
   - `Retry-After` is not exposed through CORS: the UI says "mañana", which is exact because the reset happens at local midnight.
7. **Configuration.**
   - CDK context `aiGenerationDailyLimit` (integer 0..1000, default 20; `0` blocks generation without touching DynamoDB).
   - CDK context `aiGenerationQuotaTimeZone` (IANA zone, default `America/Guayaquil`).
   - Lambda environment `AI_GENERATION_QUOTA_TABLE_NAME`, `AI_GENERATION_DAILY_LIMIT`, `AI_GENERATION_QUOTA_TIMEZONE`, set only when AI generation is enabled.
   - With generation enabled, a missing quota table fails Lambda start-up before any Bedrock client exists, and the Application service refuses to build without a quota.

## Consequences

- The daily number of Bedrock invocations is bounded: about `limit × 5` in practice, `limit × 15` at the logical ceiling. Combined with `maxTokens`, this gives a computable cost ceiling. **It is not a monetary cap**: prices, input size and Guardrail units vary.
- Trade-off: an abusive client can use up the family's quota for the day. That is an availability risk bounded to one day, in exchange for a bounded cost.
- Throttling, rounds, tokens, the execution budget, Guardrails and IAM are unchanged.
- Cost of the control itself: about one on-demand write per generation.
- Multiplayer and existing games are unaffected. Multiplayer never generates games.
- The multiplayer table now also holds this coordination item. ADR-019's rule "no further multiplayer tables or indexes" still holds.

## Out of scope

Per-player quotas, token accounting, refunds, idempotency keys, admin panels, AWS Budgets actions (they can be configured later in the console, but they react with hours of delay), and any new AWS service.
