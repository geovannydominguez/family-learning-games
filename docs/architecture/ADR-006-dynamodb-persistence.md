# ADR-006 — Use Amazon DynamoDB for Durable Persistence

## Status

Accepted for v0.3.

---

## Context

Family Learning Games v0.2 introduced a serverless backend:

```text
API Gateway HTTP API
        |
        v
AWS Lambda
        |
        v
Application / Domain
        |
        v
Repository
        |
        v
JSON / InMemory
```

The application now enters Phase 3 and requires durable storage.

The current workload has:

- small and irregular traffic
- simple key-based game/session access
- a Lambda-based backend
- TypeScript application code
- no relational query requirement
- no transactional multi-aggregate workflow requirement
- no need for an always-running database server

Candidate persistence technologies include DynamoDB, Aurora/RDS PostgreSQL, S3 and continuing with local/in-memory storage.

---

## Decision

Use **Amazon DynamoDB** as the durable persistence technology for v0.3.

```text
Application / Domain
        |
        v
Repository Contracts
        |
        v
DynamoDB Repository Implementations
        |
        v
Amazon DynamoDB
```

Use on-demand capacity for the initial development workload.

---

## Rationale

DynamoDB fits the current architecture because:

1. it is serverless and aligns naturally with Lambda
2. the current access patterns are simple and key-oriented
3. it does not require database servers, connection pools or VPC database networking
4. it scales without capacity planning for the current stage
5. on-demand billing suits irregular low traffic
6. it can be provisioned and permissioned through the existing AWS CDK stack
7. repository abstractions prevent DynamoDB concerns from leaking into domain logic

---

## Consequences

### Positive

- durable storage across Lambda invocations
- no always-running database server
- low operational overhead
- direct AWS Lambda integration
- simple IAM-based access control
- compatible with the existing repository pattern
- simple path to later scale

### Negative

- data modeling must follow access patterns
- relational joins are not available
- scans can become expensive at larger scale
- conditional writes and DynamoDB semantics must remain isolated in infrastructure code
- future reporting/access patterns may require indexes or model evolution

---

## Architectural constraint

Domain and application code must not depend on:

```text
DynamoDBClient
DynamoDBDocumentClient
PutCommand
GetCommand
UpdateCommand
ScanCommand
DynamoDB attribute-value types
table names
AWS SDK errors
```

Those belong in infrastructure implementations.

---

## Capacity mode

Use:

```text
PAY_PER_REQUEST / on-demand
```

for v0.3.

Do not introduce provisioned-capacity auto scaling without a demonstrated need.

---

## Development lifecycle

The initial v0.3 environment contains disposable development data.

CDK may configure development tables so destroying the stack also destroys the tables.

This decision must be revisited before valuable production/family-history data is stored.

---

## Rejected alternatives

### RDS / Aurora PostgreSQL

Not selected because the current model does not require joins, complex SQL queries, relational transactions or a permanently managed relational persistence layer.

It would add database networking, credentials, connections and operational complexity that v0.3 does not currently need.

### S3

Not selected as the primary database because game sessions require point reads and updates with application-level concurrency behavior.

S3 remains appropriate for future object/static assets, not for the current transactional session state.

### In-memory / local JSON

Rejected for deployed runtime persistence because Lambda execution environments are ephemeral and local files are not a durable application database.

---

## Revisit when

Reconsider if:

- relational querying becomes a primary requirement
- cross-entity transactions become materially complex
- reporting requirements dominate operational access patterns
- DynamoDB cost/access patterns become unsuitable
- a new roadmap phase introduces requirements better served by another persistence model

Any replacement or addition must be documented in a new ADR.
