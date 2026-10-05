# ADR-020 — Multiplayer Room Membership Without Cognito Using Ephemeral Capability Tokens

- **Status:** Accepted
- **Date:** 2026-10-04
- **Phase:** FASE 9 — Multiplayer
- **Version:** v0.9

## Context

Family Learning Games currently has persisted `Player` profiles but no user accounts, login, Cognito, JWTs, or family account model.

FASE 9 needs to answer a narrower question:

> After a player creates or joins a temporary room, how does the backend know that a WebSocket connection is allowed to act as that room member?

Using only:

```text
roomCode + playerId
```

would be weak because both values are discoverable/non-secret.

Introducing full user authentication solely for family-room membership would expand scope substantially.

## Decision

Do **not** introduce Cognito/login in v0.9.

Use:

```text
short roomCode
+
existing Player profile
+
opaque temporary participantToken
```

for multiplayer room membership.

The `participantToken` is an ephemeral capability scoped to one room and one player.

## Creation

When a room is created or joined, the backend generates:

```text
participantToken
```

with at least 128 bits of cryptographically secure entropy.

The backend returns the raw token once over HTTPS.

The backend persists only:

```text
hash(participantToken)
```

with the room membership.

## Scope

A token is bound to:

```text
roomId
playerId
role
expiry
```

The role is persisted server-side.

The client cannot promote itself to `HOST` by changing its request payload.

## Room code is not authentication

The room code exists so humans can join a room.

It is intentionally short and shareable.

Therefore:

```text
roomCode != secret
roomCode != authentication credential
```

A player must complete the HTTP join flow and receive a membership token before gameplay actions are authorized.

## WebSocket identification

The browser opens the WebSocket and then sends:

```json
{
  "action": "IDENTIFY",
  "roomCode": "AB7K2M",
  "playerId": "player-id",
  "participantToken": "<opaque-token>"
}
```

The backend:

1. resolves room code;
2. loads the membership;
3. hashes the presented token;
4. validates it against the stored hash;
5. validates expiry;
6. binds the WebSocket `connectionId` to the room/player.

Only then may the connection send multiplayer commands.

## Why the token is not placed in the URL

Browser WebSocket connections do not provide a general arbitrary-header mechanism equivalent to a normal authenticated HTTP client.

Putting the token in:

```text
wss://.../?token=...
```

would increase the chance that the secret appears in request/infrastructure logs.

The token is therefore sent in the first encrypted application message after connection.

## Browser storage

The token SHOULD be stored only for the active browser session.

Recommended:

```text
sessionStorage
```

This allows refresh/reconnect but avoids turning the capability into a long-lived identity.

The Service Worker must not persist it for offline use.

## Reconnect

The same valid token may re-identify the same room/player after a transient disconnect.

The latest validated connection SHOULD replace the previous active connection.

Reconnect does not create a new player or reset score.

Accepted limitation: multiplayer reconnection is supported while the ephemeral participant token remains available in the browser session. If the browser/PWA session is fully terminated and the token is lost, the participant cannot securely reclaim the existing membership in v0.9 because player profiles are not authenticated identities. No recovery based on `roomCode + playerId`, token-recovery flow, `localStorage`/IndexedDB/persistent-cookie storage, or login is added.

## Host authorization

The host receives the same kind of participant token.

Host privilege comes from server-side membership:

```text
role = HOST
```

Commands such as:

```text
START_GAME
NEXT_QUESTION
```

require both:

```text
valid membership
AND role == HOST
```

No separate permanent host password is required.

## Origin validation

The WebSocket `$connect` path SHOULD validate the browser `Origin` against configured allowed frontend origins.

This is an additional transport control.

It does not replace the participant token.

## Token/logging rules

The raw participant token MUST NOT appear in:

```text
application logs
CloudWatch structured events
analytics
error payloads
room-state broadcasts
other players' clients
```

The stored hash SHOULD also be excluded from logs.

## Expiration

Membership tokens expire with the room.

Recommended room TTL:

```text
2 hours
```

Application code checks expiry directly.

DynamoDB TTL performs eventual storage cleanup.

## Alternatives considered

### Cognito

Rejected for v0.9.

It would introduce:

- account registration;
- login;
- token lifecycle;
- authorization model;
- recovery flows;
- account-to-player relationships;

none of which are required to play a temporary family room.

Cognito can be reconsidered if the product later needs real user accounts.

### Room code only

Rejected.

Anyone with the code could impersonate any known/guessed player profile.

### Player ID only

Rejected.

`playerId` is an identifier, not a credential.

### JWT room tokens

Not selected for v0.9.

A signed JWT would work, but an opaque token plus stored hash is simpler and makes revocation/expiry naturally tied to persisted room membership.

### Token in WebSocket query string

Rejected as the default.

Secrets in URLs are easier to leak into logs.

## Consequences

### Positive

- no login friction;
- no Cognito scope expansion;
- room actions cannot rely on room code alone;
- host role remains server-controlled;
- reconnect is possible;
- tokens are short-lived and revocable with room membership.

### Negative

- this is not user authentication;
- anyone who obtains a valid participant token can act as that room member until expiry;
- the application must protect the token in browser memory/storage and logs.

These tradeoffs are acceptable for v0.9 temporary family multiplayer.

## Future reconsideration

Revisit this ADR if the application introduces:

- public users;
- remote internet matchmaking between unrelated users;
- persistent accounts;
- parental controls tied to identity;
- cross-device history ownership;
- purchases/subscriptions;
- account-based leaderboards.

At that point, temporary room capability tokens may remain useful but would sit behind real user authentication.

## Result

v0.9 room identity is:

```text
existing Player profile
+
temporary room membership
+
opaque participantToken
```

and explicitly not a permanent login system.
