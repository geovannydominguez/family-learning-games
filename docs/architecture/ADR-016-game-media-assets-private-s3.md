# ADR-016 — Game media assets and private S3 storage

**Status:** Proposed

**Date:** 2026-10-03

**Decision owners:** Family Learning Games

**Applies to:** v0.8+

---

## Context

Family Learning Games v0.7.1 stores game/player/session state in DynamoDB and serves the frontend through an online-first PWA.

FASE 8 introduces audio and images.

Binary media introduces concerns that do not belong in the existing DynamoDB game records:

- object size;
- content type;
- browser delivery;
- cacheability;
- lifecycle;
- privacy;
- provider-specific storage identifiers.

The Domain must remain independent of AWS, and existing games without media must remain valid.

For images, v0.8 also needs a safe policy. Allowing the AI Generator to invent arbitrary image URLs would create correctness, availability, privacy, copyright and content-safety problems. Runtime AI image generation would also add a new expensive/long-running inference path immediately after v0.7.1 work focused on controlling synchronous AI latency.

---

## Decision

v0.8 will introduce one **private Amazon S3 media bucket** behind provider-independent Application ports.

The bucket stores:

```text
images/
audio-cache/
```

The Domain stores only logical media references.

For a question image:

```text
assetId
altText
```

The Domain does not persist:

- S3 URLs;
- bucket names;
- object keys;
- signed URLs.

The backend resolves logical assets and returns short-lived pre-signed read URLs for presentation.

### Image policy for v0.8

Question images are limited to **application-controlled curated assets**.

v0.8 does not support:

- arbitrary remote URLs;
- runtime web image search;
- AI-generated images;
- user uploads;
- family photos.

A missing image is non-fatal; the question is shown as text-only.

---

## Rationale

### 1. Keep Domain provider-independent

A logical `assetId` is stable even if storage changes later.

### 2. Keep binary content out of DynamoDB

DynamoDB remains responsible for game/session/player state, not media blobs.

### 3. Private-by-default delivery

A private bucket plus short-lived signed GET URLs avoids a public media bucket and avoids giving AWS credentials to the browser.

### 4. Incremental phase

A single S3 bucket adds the minimum storage capability necessary for both audio cache and controlled images.

No queue, worker, workflow or separate media service is needed.

### 5. Avoid unsafe image sourcing

The system does not trust a language model to produce valid/safe/licensed remote image URLs.

### 6. Preserve future options

A later ADR may add AI image generation or uploads while writing the resulting objects into the same media abstraction.

That future change does not require replacing the Domain's logical media reference.

---

## Consequences

### Positive

- private media storage;
- shared storage primitive for audio and images;
- provider-independent Domain;
- backward-compatible optional media;
- no new DynamoDB table;
- no additional runtime image inference;
- later media sources can reuse the same storage boundary.

### Negative

- curated images require content preparation/registration;
- generated games may remain text-only;
- signed URLs expire and sometimes need resolution again;
- one new AWS resource and IAM surface must be maintained.

---

## Security requirements

The bucket must:

- block public access;
- disable public ACL usage;
- use encryption;
- allow only required Lambda access;
- use secure transport;
- never expose write credentials to the browser.

Signed URLs:

- are read-only;
- are short-lived;
- are not persisted;
- are not logged in full.

---

## Lifecycle

Derived audio objects under:

```text
audio-cache/
```

may expire automatically.

Controlled image objects under:

```text
images/
```

must not inherit the audio expiration rule.

---

## Alternatives considered

### A. Put images/audio in DynamoDB

Rejected.

Binary media is not game state and would increase item size/cost/complexity.

### B. Public S3 bucket

Rejected.

It weakens privacy/security and is unnecessary.

### C. Store permanent S3 URLs in `Game`

Rejected.

It leaks infrastructure details into Domain and makes future storage changes harder.

### D. Store all media under Next.js `public/`

Partially useful for static UI assets, but rejected as the v0.8 media architecture.

It cannot serve as the runtime cache for Polly audio and couples game content to frontend deployments.

### E. Allow arbitrary external image URLs

Rejected.

It creates broken links, third-party tracking, unsafe content and licensing/control problems.

### F. Generate images through Bedrock in the v0.8 request path

Rejected for v0.8.

It adds latency/cost and conflicts with the incremental goal of the phase. Image generation can be reconsidered separately, likely with asynchronous execution.

---

## Relationship to previous ADRs

This ADR does not supersede:

- ADR-009;
- ADR-011;
- ADR-012;
- ADR-013;
- ADR-014;
- ADR-015.

ADR-014 remains authoritative for PWA caching. Dynamic signed media is not promoted to permanent offline content by this decision.
