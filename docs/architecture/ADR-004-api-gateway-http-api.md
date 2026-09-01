# ADR-004 — Use Amazon API Gateway HTTP API

## Status

Accepted for v0.2.

---

## Context

Family Learning Games v0.2 requires an HTTP entry point for the AWS Lambda backend.

Candidate routes include:

```text
GET  /games
GET  /games/{gameId}
POST /game-sessions
POST /game-sessions/{sessionId}/answers
GET  /game-sessions/{sessionId}
```

The project does not currently require advanced API-management functionality.

AWS API Gateway provides HTTP API and REST API options relevant to this decision.

---

## Decision

Use **Amazon API Gateway HTTP API** for v0.2.

```text
Browser / Next.js
       |
       v
API Gateway HTTP API
       |
       v
AWS Lambda
```

---

## Rationale

HTTP API is preferred because the API is small, routing requirements are simple, Lambda integration is direct, configuration is simpler than REST API and the project does not need REST API-specific capabilities.

The goal of v0.2 is backend foundation, not advanced API management.

---

## Consequences

### Positive

* simpler infrastructure
* fewer API Gateway concepts
* lower operational complexity
* good fit for JSON HTTP endpoints
* direct Lambda integration

### Negative

Some REST API features are not available or differ in HTTP API. If those become necessary, the decision may need to be revisited.

---

## API principles

Prefer JSON, resource-oriented routes, explicit HTTP methods, explicit status codes, small DTOs and consistent error mapping.

Avoid generic action endpoints when normal HTTP resource semantics are sufficient.

---

## CORS

CORS should be configured only for frontend origins required by the application.

During local development, localhost origins may be permitted as needed.

Do not use unrestricted CORS in deployed environments without a concrete reason.

---

## Rejected alternative

### API Gateway REST API

Not selected because the current backend does not require REST API-specific capabilities and the additional configuration would add unnecessary complexity.

---

## Revisit when

Reconsider if a concrete requirement appears for capabilities materially better supported by REST API or another API technology.

Any replacement should be documented in a new ADR.
