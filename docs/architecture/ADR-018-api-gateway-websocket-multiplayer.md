# ADR-018 — API Gateway WebSocket API for Multiplayer Real-Time Communication

- **Status:** Accepted
- **Date:** 2026-10-04
- **Phase:** FASE 9 — Multiplayer
- **Version:** v0.9

## Context

Family Learning Games v0.8 is an online-first PWA with an existing HTTP API Gateway API and one backend Lambda.

FASE 9 requires multiple players on different devices to receive room and gameplay changes in real time:

```text
player joins
game starts
question opens
question reveals
scoreboard changes
game finishes
```

HTTP polling could implement this behavior, but it would add latency, repeated requests, and more client coordination.

The project does not need GraphQL, public matchmaking, or a larger real-time platform.

## Decision

Add an **Amazon API Gateway WebSocket API** for multiplayer real-time communication.

Keep the existing HTTP API for room bootstrap operations.

Both APIs integrate with the existing:

```text
family-learning-games-backend
```

Lambda.

No second gameplay Lambda is introduced.

### HTTP responsibilities

```text
POST /multiplayer/rooms
POST /multiplayer/rooms/{roomCode}/join
```

### WebSocket responsibilities

Recommended routes:

```text
$connect
$disconnect
$default
IDENTIFY
START_GAME
SUBMIT_ANSWER
QUESTION_TIMEOUT
NEXT_QUESTION
SYNC_ROOM
```

Recommended route selection:

```text
$request.body.action
```

The backend sends events to connected clients through the API Gateway Management API (`postToConnection`).

## Rationale

This choice:

- fits the current serverless AWS architecture;
- provides bidirectional communication;
- avoids polling;
- preserves the existing HTTP API;
- preserves one backend Lambda;
- requires no AppSync/GraphQL adoption;
- requires no permanently running server;
- scales independently through managed AWS infrastructure.

## Alternatives considered

### HTTP polling

Rejected for v0.9.

It would work technically but introduces:

- repeated no-change requests;
- delayed room updates;
- more client synchronization code;
- worse multiplayer feel.

### Server-Sent Events

Not selected.

The game requires client → server gameplay commands and server → client updates. WebSockets provide the required bidirectional channel directly.

### AWS AppSync subscriptions

Rejected for v0.9.

AppSync would introduce GraphQL and a new application/API model that the project does not otherwise need.

### Dedicated WebSocket Lambda(s)

Rejected for v0.9.

The existing backend Lambda can route both HTTP API v2 and WebSocket API events while the application remains modular internally.

Separate Lambdas may be reconsidered only if operational or scaling evidence justifies them.

### Self-managed WebSocket server

Rejected.

EC2/ECS/EKS would increase deployment and operational complexity without a current requirement.

## Connection behavior

`$connect` establishes transport.

A socket is not considered an authorized room member until the application processes `IDENTIFY`.

`$disconnect` is best-effort and cannot be the only stale-connection cleanup mechanism.

The backend must also clean stale mappings when callback delivery indicates that a connection no longer exists.

## Security

v0.9 does not introduce Cognito.

`$connect` SHOULD validate allowed browser origins.

Room authorization is performed through the temporary membership capability defined in ADR-020.

The frontend receives no AWS credentials.

The Lambda receives least-privilege permission for:

```text
execute-api:ManageConnections
```

scoped to the multiplayer WebSocket API.

## Consequences

### Positive

- real-time multiplayer;
- managed infrastructure;
- minimal change to the current architecture;
- frontend and backend remain online-first;
- no new application protocol framework.

### Negative

- the backend must manage connection identifiers;
- WebSocket reconnection becomes an application concern;
- broadcast failures must be handled per connection;
- local testing is more complex than plain HTTP.

## AWS-specific details remain Infrastructure concerns

Domain/Application MUST NOT depend on:

```text
ApiGatewayManagementApiClient
connection ARN formats
API Gateway SDK exceptions
CDK constructs
```

Application depends on a broadcaster port instead.

## Result

FASE 9 uses:

```text
Existing HTTP API
        +
API Gateway WebSocket API
        ↓
same backend Lambda
```

for multiplayer.
