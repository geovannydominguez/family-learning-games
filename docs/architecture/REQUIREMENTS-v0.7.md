# REQUIREMENTS-v0.7 — Progressive Web App

## 1. Version

**Version:** v0.7
**Phase:** FASE 7 — PWA
**Status:** Proposed

---

## 2. Objective

Convert the existing Family Learning Games web application into an installable Progressive Web App while preserving the current frontend, backend, persistence, AI game generation, and player-profile architecture.

The application must continue to be accessible normally through:

```text
https://play.joamgames.com
```

and additionally provide an app-like experience when installed on supported devices.

v0.7 focuses on:

* PWA installability.
* Application manifest.
* PWA icons.
* Service Worker registration.
* Basic static asset caching.
* Offline fallback experience.
* Safe update behavior.
* Compatibility with the existing deployed application.

v0.7 does **not** introduce offline gameplay or synchronization of backend data.

---

## 3. User value

As a family member,

I want to install Family Learning Games on my phone, tablet, or computer,

so that I can access the application from my home screen and use it with an experience closer to a native application.

---

# 4. Functional requirements

## FR-01 — Web App Manifest

The application must expose a valid Web App Manifest.

The manifest must define at least:

```text
name
short_name
description
start_url
display
background_color
theme_color
icons
```

Recommended configuration:

```text
name: Family Learning Games
short_name: JOAM Games
start_url: /
display: standalone
```

The implementation should use the native Next.js metadata capabilities already available in the project when appropriate.

---

## FR-02 — Application icons

The application must provide PWA-compatible icons.

At minimum:

```text
192x192
512x512
```

A maskable-compatible icon should also be available when practical.

Icons must represent the JOAM Games / Family Learning Games application and must not depend on externally hosted resources.

---

## FR-03 — Installability

The application must satisfy the browser requirements necessary to allow installation as a PWA on supported platforms.

Installation must preserve:

```text
https://play.joamgames.com
```

as the trusted application origin.

After installation, launching the application must open Family Learning Games in standalone mode where supported.

---

## FR-04 — Service Worker

The frontend must register a Service Worker.

The Service Worker is responsible only for concerns belonging to the client/PWA layer.

Its introduction must not modify:

* Domain.
* Application use cases.
* DynamoDB repositories.
* Lambda routes.
* API Gateway contracts.
* Bedrock generation.
* Player persistence.

---

## FR-05 — Static resource caching

The PWA may cache resources required to render the application shell, such as:

```text
icons
fonts
static JavaScript
static CSS
offline page assets
other immutable/static resources
```

Caching must use explicit cache names with a versioning strategy.

Example concept:

```text
joam-static-v1
```

Changing the application cache version must allow obsolete cache entries to be removed.

---

## FR-06 — API requests must remain online

Requests to the Family Learning Games backend must **not** be served from the Service Worker cache in v0.7.

This includes APIs such as:

```text
GET /game-setup
POST /game-sessions
GET /game-sessions/{id}
POST /games/generate
player APIs
```

and any other backend request introduced in previous versions.

For v0.7:

```text
API request
    ↓
Network
    ↓
API Gateway
    ↓
Backend Lambda
```

There must be no cached API response acting as a substitute for backend state.

---

## FR-07 — Offline fallback

If the application cannot load a navigation request because the device is offline, the user must receive a controlled offline experience instead of a generic browser/network error.

The application should provide an offline screen with a child/family-friendly message.

Example behavior:

```text
No network
   ↓
Navigation fails
   ↓
Service Worker
   ↓
Offline fallback page
```

The offline page should clearly indicate that an Internet connection is required to start or continue operations requiring backend access.

---

## FR-08 — Existing online gameplay

When connectivity is available, all existing flows must continue to behave exactly as before v0.7.

This includes at least:

* Player selection.
* Player profiles.
* Category selection.
* Difficulty selection.
* Existing games.
* AI-generated games.
* Game sessions.
* Questions and answers.
* Results.
* Persistence.

PWA support must be additive and must not alter the behavior of these features.

---

## FR-09 — PWA updates

A newly deployed application version must eventually replace the previous cached PWA assets.

The Service Worker must implement predictable lifecycle handling for:

```text
install
activate
fetch
```

Obsolete caches must be deleted during activation.

v0.7 does not require a sophisticated in-app update notification.

---

## FR-10 — Secure context

Production PWA capabilities must operate through HTTPS.

The existing production origin:

```text
https://play.joamgames.com
```

already represents the public application endpoint and remains the canonical production URL.

---

# 5. Non-functional requirements

## NFR-01 — Architecture compatibility

The implementation must preserve the architecture established in previous versions.

No PWA-specific business logic may leak into:

```text
Domain
Application
Backend repositories
Lambda handlers
```

---

## NFR-02 — Progressive enhancement

Failure or lack of support for Service Workers or application installation must not prevent the user from using the normal web application while online.

The PWA capability must be an enhancement over the existing web application.

---

## NFR-03 — No stale business data

The Service Worker must not cache backend JSON responses containing:

* player data;
* game sessions;
* generated games;
* gameplay state;
* AI results;
* application state originating from DynamoDB.

This prevents stale browser state from conflicting with DynamoDB as the persistence source of truth.

---

## NFR-04 — Performance

PWA support must not introduce significant additional work into the critical runtime path of the application.

Static asset caching may improve subsequent application startup, but performance optimization is not the primary objective of v0.7.

---

## NFR-05 — Maintainability

PWA configuration must:

* remain understandable from the repository;
* avoid hidden infrastructure configuration;
* be covered by automated tests where practical;
* contain explicit cache/version naming;
* document its runtime behavior.

---

# 6. Scope

## Included

v0.7 includes:

```text
Web App Manifest
PWA icons
Next.js metadata integration
Service Worker
Service Worker registration
static asset caching
offline fallback
cache cleanup/versioning
installation validation
production validation in play.joamgames.com
documentation
tests
```

---

## Not included

The following capabilities are explicitly outside v0.7:

```text
Offline gameplay
Offline game-session persistence
IndexedDB game synchronization
Background Sync
Push notifications
Web Push
Backend changes specifically for offline support
Conflict resolution
Offline AI game generation
Cached Bedrock results for offline use
Native Android/iOS packaging
App Store / Play Store publication
```

These capabilities may be considered in future versions.

---

# 7. Data considerations

No new DynamoDB table is required.

v0.7 must continue using the persistence architecture already implemented in previous phases.

The Service Worker cache is **not** considered application persistence.

It is only a delivery/performance mechanism for frontend static resources.

---

# 8. Backend considerations

No backend API modification is expected for v0.7.

The existing architecture remains:

```text
Browser / Installed PWA
        │
        │ HTTPS
        ▼
Amplify Hosting
        │
        │ frontend
        ▼
Next.js application
        │
        │ HTTPS
        ▼
API Gateway HTTP API
        │
        ▼
Backend Lambda
        │
        ├── DynamoDB
        │
        └── Amazon Bedrock
```

PWA behavior exists exclusively in the frontend/browser boundary.

---

# 9. Acceptance criteria

v0.7 is considered complete when all of the following are satisfied.

### AC-01

Opening:

```text
https://play.joamgames.com
```

continues to load the normal Family Learning Games application.

### AC-02

The browser detects a valid Web App Manifest.

### AC-03

The application can be installed as a PWA on at least one supported desktop browser.

### AC-04

The application can be added/installed on at least one supported mobile platform.

### AC-05

Launching the installed application opens Family Learning Games with standalone application behavior where supported.

### AC-06

The installed application displays the expected JOAM Games icon and application name.

### AC-07

A Service Worker is successfully installed and activated.

### AC-08

Static application resources can be observed in the expected browser cache.

### AC-09

Backend API responses are not persisted in the PWA static cache.

### AC-10

With connectivity available, existing game flows continue working without behavioral regressions.

### AC-11

With connectivity disabled, a controlled offline page/message is presented when an uncached navigation cannot be completed.

### AC-12

Re-enabling connectivity restores normal application behavior.

### AC-13

After deploying a new frontend version, obsolete static cache versions can be removed.

### AC-14

All project standard validations pass.

---

# 10. Standard validations

Before v0.7 can be closed, execute:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

All commands must complete successfully.

Existing tests from previous phases must remain green.

---

# 11. Manual PWA validation

Validation must also include browser inspection.

Verify:

```text
Manifest detected
Application name
Application icons
start_url
display mode
Service Worker installed
Service Worker activated
Cache created
Offline fallback
Installability
Installed application launch
API requests remain network-based
```

The production validation must be performed against:

```text
https://play.joamgames.com
```

---

# 12. Definition of Done

FASE 7 / v0.7 is complete when:

```text
✓ application is installable
✓ manifest is valid
✓ icons are available
✓ Service Worker is operational
✓ static resources are safely cached
✓ dynamic APIs are not cached
✓ offline fallback works
✓ existing online game flows still work
✓ production deployment works
✓ standard validations pass
✓ documentation is updated
```
