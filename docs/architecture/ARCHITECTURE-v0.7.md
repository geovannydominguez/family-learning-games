# ARCHITECTURE-v0.7 — Progressive Web App

## 1. Purpose

v0.7 introduces Progressive Web App capabilities into Family Learning Games.

This version does not redesign the application architecture.

Instead, it adds a PWA delivery layer around the existing Next.js frontend.

The fundamental architecture continues to be:

```text
Next.js
   │
   ▼
Application APIs
   │
   ▼
AWS Serverless Backend
```

The new concern is:

```text
Browser / PWA runtime
        │
        ├── Manifest
        ├── Service Worker
        ├── Static Cache
        └── Offline Fallback
```

---

# 2. Architecture goals

v0.7 must achieve four architectural objectives:

1. Make Family Learning Games installable.
2. Improve application-like behavior.
3. Provide graceful behavior when connectivity is unavailable.
4. Avoid introducing offline consistency problems into backend data.

---

# 3. Current architecture

Before v0.7:

```text
┌───────────────────────────┐
│ User Browser              │
└─────────────┬─────────────┘
              │
              │ HTTPS
              ▼
┌───────────────────────────┐
│ AWS Amplify Hosting       │
│ play.joamgames.com        │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Next.js Frontend          │
└─────────────┬─────────────┘
              │
              │ HTTPS
              ▼
┌───────────────────────────┐
│ API Gateway HTTP API      │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Backend Lambda            │
└──────────┬───────┬────────┘
           │       │
           ▼       ▼
      DynamoDB   Bedrock
```

---

# 4. v0.7 architecture

v0.7 introduces the Service Worker between the browser runtime and frontend resource retrieval.

```text
                       Internet
                          │
                          ▼
              ┌─────────────────────┐
              │ Amplify Hosting     │
              │ play.joamgames.com  │
              └──────────┬──────────┘
                         │
                         ▼
┌────────────────────────────────────────────┐
│ Browser / Installed PWA                    │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ Next.js Application                  │  │
│  └───────────────┬──────────────────────┘  │
│                  │                         │
│  ┌───────────────▼──────────────────────┐  │
│  │ Service Worker                       │  │
│  │                                      │  │
│  │ - lifecycle                          │  │
│  │ - static cache                       │  │
│  │ - offline fallback                   │  │
│  └───────────────┬──────────────────────┘  │
│                  │                         │
│        ┌─────────▼─────────┐               │
│        │ Cache Storage     │               │
│        │ static resources │               │
│        └───────────────────┘               │
└───────────────────┬────────────────────────┘
                    │
                    │ Backend requests
                    │ NETWORK ONLY
                    ▼
          ┌─────────────────────┐
          │ API Gateway         │
          │ HTTP API            │
          └──────────┬──────────┘
                     ▼
          ┌─────────────────────┐
          │ Backend Lambda      │
          └────────┬────────────┘
                   │
             ┌─────┴─────┐
             ▼           ▼
          DynamoDB     Bedrock
```

---

# 5. Main components

## 5.1 Web App Manifest

The manifest describes how the application behaves when installed.

Conceptually:

```text
Browser
   │
   └── reads manifest
          │
          ├── name
          ├── icons
          ├── colors
          ├── start URL
          └── display mode
```

The manifest belongs entirely to the frontend layer.

Where supported by the project's current Next.js version and structure, the implementation should favor Next.js-native metadata conventions instead of adding unnecessary framework abstractions.

---

## 5.2 Service Worker

The Service Worker acts as the PWA runtime boundary.

Responsibilities:

```text
install
activate
fetch handling
static caching
offline navigation fallback
obsolete cache cleanup
```

It must not contain:

```text
game rules
player rules
AI generation rules
domain decisions
DynamoDB state
session persistence rules
```

---

# 6. Cache architecture

The cache must distinguish static frontend concerns from dynamic application data.

## Cacheable

Examples:

```text
PWA icons
offline page
fonts
static CSS
static JavaScript
immutable Next.js assets
other versioned static assets
```

Conceptually:

```text
Static Request
      │
      ▼
Service Worker
      │
      ├── cache hit ─────► cached resource
      │
      └── cache miss ────► network
```

---

## Not cacheable as application data

The Service Worker must not use cached API responses as application state.

Examples:

```text
/api...
API Gateway URLs
player records
game sessions
generated games
Bedrock output
game setup response
game results
```

Conceptually:

```text
Backend API Request
      │
      ▼
Service Worker
      │
      └────────────► NETWORK
                        │
                        ▼
                   API Gateway
```

This decision prevents the browser cache from becoming a second inconsistent application database.

---

# 7. Offline architecture

v0.7 introduces **offline fallback**, not **offline gameplay**.

These concepts must remain separate.

### Supported

```text
No network
   ↓
Page navigation cannot complete
   ↓
Service Worker
   ↓
Offline fallback
```

### Not supported

```text
No network
   ↓
Play full game
   ↓
Store session locally
   ↓
Reconnect
   ↓
Synchronize DynamoDB
```

The latter would require synchronization, conflict handling, local persistence, ownership rules, and explicit application-level offline semantics.

That is outside v0.7.

---

# 8. Installation architecture

Installation remains a browser/platform responsibility.

The application provides:

```text
Manifest
+
Icons
+
Service Worker
+
HTTPS
```

The platform determines the exact user interaction for installation.

After installation:

```text
Home Screen / App Launcher
          │
          ▼
     JOAM Games
          │
          ▼
   start_url: /
          │
          ▼
play.joamgames.com
```

The installed application does not introduce a second deployment target.

---

# 9. Deployment architecture

There is no new AWS runtime component for v0.7.

The deployment remains:

```text
GitHub
   │
   ▼
Amplify Hosting
   │
   ▼
Next.js frontend
```

The PWA files are part of the frontend artifact deployed through the existing Amplify pipeline.

The following components remain unchanged:

```text
Route 53
Amplify Hosting
API Gateway
Lambda
DynamoDB
Amazon Bedrock
CDK backend stack
```

Unless implementation discovers a concrete hosting/header requirement, no new AWS infrastructure should be introduced.

---

# 10. Repository impact

Expected frontend-oriented changes may include files equivalent to:

```text
app/
public/
  icons/
  sw.js
  offline assets
```

and/or framework-specific manifest/metadata files supported by the project's current Next.js structure.

The implementation must inspect the existing project before choosing exact paths.

Potential logical additions:

```text
manifest
service-worker registration
offline route/page
PWA icon assets
PWA-specific tests
```

Do not restructure Domain, Application, or backend Infrastructure solely for PWA support.

---

# 11. Service Worker lifecycle

## Install

During installation the Service Worker may prepare the minimum resources required for the offline experience.

```text
install
   │
   ▼
pre-cache offline shell/resources
```

---

## Activate

On activation:

```text
activate
   │
   ▼
enumerate caches
   │
   ▼
delete obsolete application caches
```

Only caches owned by Family Learning Games should be deleted.

The implementation must never indiscriminately delete unrelated browser caches.

---

## Fetch

Fetch handling must classify requests.

Conceptually:

```text
                    Request
                       │
             ┌─────────┴─────────┐
             │                   │
         static asset         backend/API
             │                   │
             ▼                   ▼
       cache strategy        network only
```

Navigation requests that fail due to connectivity may return the offline fallback.

---

# 12. Failure behavior

## Online

```text
PWA
 ↓
Network
 ↓
Normal application
```

No behavioral change from v0.6.

---

## Offline with cached application resources

Static resources may continue to load from cache.

Backend-dependent operations must clearly fail or report that Internet connectivity is required.

---

## Offline uncached navigation

Return the offline fallback instead of exposing a generic browser failure.

---

# 13. Security considerations

The PWA must continue respecting the same HTTPS origin.

No sensitive application state should be intentionally stored in Service Worker caches.

PWA cache scope must remain limited to frontend resources.

Backend communication remains protected through the existing HTTPS APIs.

No authentication or authorization design is introduced by this phase.

---

# 14. Observability

v0.7 does not require a new observability backend.

Browser validation should make it possible to inspect:

```text
Manifest
Service Worker state
Cache Storage
Network behavior
Application installation
```

Application/API errors continue using the existing mechanisms.

---

# 15. Testing strategy

Testing must cover three levels.

## Automated

Validate:

```text
manifest configuration
Service Worker-related utilities when practical
registration logic
offline fallback configuration
existing regression suite
```

---

## Local production build

PWA behavior should be validated using the project's production-compatible build rather than relying exclusively on development mode.

The development runtime must not be treated as proof that Service Worker lifecycle behavior is correct.

---

## Production

Validate:

```text
https://play.joamgames.com
```

using browser developer tools and a real installation.

At minimum test:

```text
normal online load
installation
launch installed app
Service Worker active
cache populated
offline navigation
restore network
existing complete game flow
AI-generated game flow
player-specific flow
```

---

# 16. Standard validation pipeline

The project quality gate remains:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

v0.7 must not weaken any validation introduced in earlier versions.

---

# 17. Architectural boundaries

The final architecture boundary is:

```text
┌──────────────────────────────────────┐
│ Presentation / PWA                   │
│                                      │
│ Next.js                              │
│ Manifest                             │
│ Service Worker                       │
│ Offline fallback                     │
│ Browser Cache                        │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ Existing Application / Backend       │
│                                      │
│ Use cases                            │
│ API Gateway                          │
│ Lambda                               │
│ repositories                         │
│ DynamoDB                             │
│ Bedrock                              │
└──────────────────────────────────────┘
```

PWA infrastructure must not cross this boundary.

---

# 18. Key architectural decision

v0.7 adopts the following principle:

> **Installable online-first PWA with static offline fallback, not an offline-first application.**

This provides immediate value for Family Learning Games while keeping application state authoritative in the existing backend.

---

# 19. Expected result

After v0.7:

```text
Family Learning Games
        │
        ├── accessible by browser
        │
        ├── installable as JOAM Games
        │
        ├── standalone experience
        │
        ├── basic offline fallback
        │
        └── existing AWS backend unchanged
```

This prepares the frontend for later capabilities such as richer offline behavior or device integrations without introducing those complexities prematurely.
