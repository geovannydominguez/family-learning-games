# ADR-009 — Validate AI-generated games before persistence and decouple gameId from categoryId

## Status
Accepted for v0.4.

## Context
v0.3 seeded games used category IDs as game IDs. AI generation creates a one-category-to-many-games relationship and introduces untrusted probabilistic output.

## Decision

### Independent game identity
Existing seeded IDs may remain unchanged for compatibility.

Generated games use a unique ID:

```text
gameId != categoryId
```

Example:

```text
categoryId = animals
gameId = animals          # existing seeded game
gameId = ai-<unique-id>   # generated game
```

The Application creates this trusted `gameId` through an injected ID factory after validating the provider draft. The generator/provider must not choose durable identity.

The repository creates the item conditionally so an ID collision cannot overwrite an existing game. A collision is translated to an application-level conflict and does not consume the single model-regeneration retry.

No table migration is required because `Games` already uses `gameId` as PK.

### Backward-compatible session selection

`POST /game-sessions` accepts an optional `gameId` in addition to the v0.3 fields.

- when `gameId` is present, it selects that exact game and takes precedence over category-based lookup;
- the selected game's category must remain coherent with the supplied `categoryId`;
- when `gameId` is absent, the existing v0.3 `categoryId` behavior remains unchanged;
- the generated-game UI sends the returned `gameId` when starting a session.

This is an additive contract change, not a breaking replacement of `categoryId`.

### Validate before persistence

```text
provider response
  ↓
parse
  ↓
structural validation
  ↓
domain validation
  ↓
normalization
  ↓
Game
  ↓
DynamoDB
```

Invalid generated data must never enter durable storage.

### One game domain
Seeded and generated games use the same `Game` and `GameSession` models.

## Minimum validation
- required title/category/questions
- exactly 10 questions
- supported difficulty
- non-empty text
- topic length at most 80 characters
- title length at most 100 characters
- question text length at most 240 characters
- answer text length at most 120 characters
- category ID/name/description/icon lengths at most 80/100/300/16 characters
- question and answer ID lengths at most 80 characters
- optional emoji/image lengths at most 16/2048 characters
- exactly 4 answers per question
- exactly one correct answer
- unique question IDs
- unique answer IDs per question
- category consistency

All generated string fields are trimmed and must be non-empty when required or supplied.

A Bedrock Guardrail intervention is treated as rejected generated content before persistence and mapped without exposing provider details. Prompt constraints, deep validation, and at most one regeneration attempt remain complementary safeguards. Unbounded retries are prohibited.

## Rejected alternatives
- keep `gameId = categoryId` forever
- overwrite the category game on every generation
- persist raw AI JSON and validate later
- create a separate `GeneratedGames` table

## Review triggers
Revisit if catalog access patterns require indexes, generated content needs lifecycle policies, or moderation becomes an independent workflow.
