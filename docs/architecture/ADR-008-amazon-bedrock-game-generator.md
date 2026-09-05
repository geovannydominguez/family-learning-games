# ADR-008 — Use Amazon Bedrock behind a GameGenerator port

## Status
Accepted for v0.4.

## Context
v0.4 introduces AI-generated games. Calling Bedrock directly from route handlers or Application would couple core logic to AWS SDK/model request formats.

## Decision
Use Amazon Bedrock as the v0.4 AI provider behind a provider-neutral Application port:

```ts
interface GameGenerator {
  generate(request: GenerateGameRequest): Promise<GeneratedGameDraft>;
}
```

Infrastructure implements:

```text
BedrockGameGenerator implements GameGenerator
```

The concrete model is configuration, not a domain decision.

Use configuration such as:

```text
AI_GAME_GENERATION_ENABLED
BEDROCK_MODEL_ID
BEDROCK_REGION
BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
```

Reuse the existing backend Lambda for v0.4.

AI generation is disabled by default. Model and Guardrail configuration are required only when it is enabled. The stack defaults to `us-east-1`; changing `deploymentRegion` deploys the whole stack there. CDK derives `BEDROCK_REGION`, the model ARN, and the Guardrail from that single stack region and never creates a cross-region Bedrock configuration. CDK provisions a basic configurable Bedrock Guardrail and grants the Lambda only the model-invocation, Guardrail-application, and enabled-only game-creation permissions it needs. Domain and Application remain unaware of Guardrail identifiers and provider intervention details.

Every enabled invocation applies the configured Guardrail and limits model output to 4096 tokens. A Guardrail intervention is translated to a safe application error without exposing provider details and may use the one allowed regeneration attempt.

Synchronous generation uses a 28-second Lambda timeout budget. API Gateway HTTP API remains the entry point and applies configurable throttling only to `POST /games/generate`, with defaults of 1 request/second and burst 2. HTTP `429` is surfaced without aggressive frontend retry.

### Age-aware generation

AI-generated games must be appropriate for the selected player's age.

The `Player` domain model includes the player's age:

```ts
interface Player {
  id: string;
  name: string;
  avatar: string;
  age: number;
}
```

The public generation command carries `playerId`. `GenerateGameService` resolves that
player from the authoritative repository data, rejects a missing player or a non-positive
integer age, and sends the provider-neutral generator request only `targetAge` with the
topic, difficulty, and question count. Player ID, name, and avatar never reach Bedrock.

For ages 4 through 6, the Bedrock prompt additionally excludes powers/exponents, square
roots, algebra, advanced fractions, advanced multiplication/division, and obviously
age-inappropriate concepts. This is a bounded prompt safeguard, not a profile or
curriculum model.

## Rationale
This preserves:

- AWS-independent Domain/Application code
- provider/model replaceability
- testability using fake generators
- the current simple serverless topology
- centralized validation and persistence
- age-aware generation without introducing the Family Profiles scope planned for FASE 6

## Consequences

### Positive
- Bedrock SDK stays in Infrastructure.
- Tests do not require live AI.
- Model changes do not redesign core logic.
- No extra always-on infrastructure.
- Generated content can be contextualized to the player's age without exposing the player's identity to the AI provider.

### Negative
- Synchronous generation adds request latency.
- Bedrock IAM/config must be managed.
- Guardrail configuration and throttling become part of the CDK contract.
- Probabilistic output requires strict validation.
- Player age is currently maintained as static game data; profile management and richer learning context remain deferred to FASE 6.

## Rejected alternatives

### Bedrock directly from browser
Rejected due to security and cloud-coupling concerns.

### Bedrock SDK inside Application
Rejected because it breaks provider independence.

### SQS + worker Lambda now
Rejected as unnecessary complexity until real latency requires async generation.

### Separate AI microservice
Rejected at current scale.

## Review triggers
Revisit if synchronous latency is consistently unacceptable, multiple providers are required, or generation becomes an asynchronous workflow.
