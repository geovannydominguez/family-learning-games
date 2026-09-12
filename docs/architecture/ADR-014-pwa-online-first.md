# ADR-014 — Adopt an online-first Progressive Web App with controlled static caching

## Status

**Accepted for v0.7.**

---

## Context

Family Learning Games is currently delivered as a web application using Next.js and AWS Amplify Hosting.

Previous versions introduced:

* the playable frontend;
* serverless backend APIs;
* DynamoDB persistence;
* AI game generation through Amazon Bedrock;
* public deployment through Amplify;
* custom domain `play.joamgames.com`;
* persistent family player profiles.

The next roadmap phase is FASE 7 — Progressive Web App.

The application should become installable on supported devices and provide an app-like experience.

However, turning the application into a fully offline-capable system would introduce additional architectural concerns:

* local game persistence;
* browser database design;
* synchronization;
* conflict resolution;
* reconnect behavior;
* local/backend state reconciliation;
* offline game-generation limitations;
* stale player data;
* stale game-session data.

These concerns are larger than the objective of FASE 7.

---

## Decision

Family Learning Games will become an **online-first Progressive Web App**.

v0.7 will add:

```text
Web App Manifest
PWA icons
Service Worker
static resource caching
offline fallback
installability
cache lifecycle/versioning
```

The Service Worker may cache static frontend resources required to provide the application shell and offline fallback.

Backend API responses will remain **network-based and will not be treated as cacheable application state**.

The PWA cache is therefore a delivery mechanism, not an application persistence mechanism.

---

## Runtime model

```text
                 Installed PWA
                      │
                      ▼
                Next.js frontend
                      │
              ┌───────┴────────┐
              │                │
        Static resource     API request
              │                │
              ▼                ▼
       Service Worker       Network
              │                │
              ▼                ▼
        Cache Storage     API Gateway
                               │
                               ▼
                             Lambda
                               │
                               ▼
                            DynamoDB
```

---

## Cache policy

### Static frontend resources

Static resources may use an explicit caching strategy.

Examples:

```text
icons
offline fallback
static JavaScript
static CSS
fonts
immutable frontend resources
```

### Dynamic application data

The following must not be stored as authoritative data in the PWA cache:

```text
players
games returned from APIs
game sessions
game results
AI generation responses
Bedrock-generated questions
DynamoDB-derived application state
```

These requests remain dependent on the backend.

---

## Offline behavior

When offline, the PWA may display previously cached static application resources.

If a navigation cannot be completed, an offline fallback must be displayed.

The application is **not required to support gameplay while disconnected**.

Therefore:

```text
PWA offline support != offline gameplay
```

---

## Why not offline-first?

An offline-first strategy would require an additional persistence model inside the browser.

For example:

```text
Browser DB
    │
    ├── players
    ├── games
    ├── answers
    └── sessions
```

and synchronization logic:

```text
Local state
    │
Reconnect
    │
    ▼
Conflict detection
    │
    ▼
Backend synchronization
```

This would make v0.7 significantly more complex and could undermine the current rule that backend persistence is authoritative.

The benefit is not required to achieve the FASE 7 objective.

---

## Why use a Service Worker?

A Service Worker provides the browser capability required to control PWA caching and offline behavior independently from application business logic.

It provides a suitable boundary for:

```text
install
activate
fetch
cache lifecycle
offline fallback
```

without changing the Domain or Application layers.

---

## Why keep API responses out of static cache?

Game and player information can change over time.

Caching these responses without explicit application semantics could result in:

```text
stale players
stale games
stale sessions
conflicting state
incorrect game progress
```

Avoiding API caching keeps:

```text
DynamoDB/backend = source of truth
```

and preserves existing consistency assumptions.

---

## Consequences

### Positive

* Family Learning Games becomes installable.
* Users can launch JOAM Games from their device home screen.
* Frontend startup may benefit from cached static resources.
* Network failure receives a controlled user experience.
* No backend redesign is needed.
* No new DynamoDB tables are required.
* Existing API contracts remain unchanged.
* The current Amplify deployment model remains valid.
* Future offline functionality can be introduced separately.

### Negative

* Games cannot be fully played offline in v0.7.
* Generated games still require connectivity.
* Player and session operations still require connectivity.
* A Service Worker adds another frontend lifecycle that must be tested carefully.
* Cached frontend versions can temporarily coexist during deployment and require explicit cache cleanup.

---

## Alternatives considered

### Alternative A — Keep the application as a normal website

Rejected.

This does not satisfy the FASE 7 objective and provides no installable application experience.

---

### Alternative B — Full offline-first PWA

Rejected for v0.7.

It would require local persistence and synchronization semantics that are outside the intended scope of this phase.

It may be reconsidered in a future version.

---

### Alternative C — Cache API responses automatically

Rejected.

Generic caching of API responses risks stale or inconsistent application state.

Any future API caching must be explicitly designed around the semantics of each use case.

---

### Alternative D — Build native Android/iOS applications

Rejected.

The current application is already based on Next.js and publicly deployed as a web application.

Native application development is not required to achieve installability in this phase and would create a separate delivery architecture.

---

## Implementation constraints

The implementation must:

1. preserve the existing Next.js architecture;
2. use the current production origin;
3. register a Service Worker;
4. provide a valid Web App Manifest;
5. provide appropriate PWA icons;
6. provide an offline fallback;
7. explicitly version owned browser caches;
8. remove obsolete owned caches;
9. avoid caching backend state as static application data;
10. keep existing application behavior unchanged while online.

---

## Infrastructure impact

No new AWS infrastructure component is expected.

The current deployment path remains:

```text
GitHub
   ↓
AWS Amplify Hosting
   ↓
play.joamgames.com
```

The existing backend remains:

```text
API Gateway
   ↓
Lambda
   ├── DynamoDB
   └── Amazon Bedrock
```

PWA assets are deployed as part of the frontend.

---

## Validation

The implementation must pass the standard repository checks:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

It must additionally be manually validated for:

```text
manifest
icons
installation
standalone launch
Service Worker registration
Service Worker activation
cache creation
offline fallback
network restoration
existing gameplay regression
production behavior at play.joamgames.com
```

---

## Final decision

For v0.7, Family Learning Games will use:

> **an installable online-first PWA with Service Worker controlled static caching and an offline fallback, while keeping all backend application data network-authoritative.**

Any future offline gameplay capability must be designed as a separate architectural decision rather than being implicitly introduced through Service Worker caching.
