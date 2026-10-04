# ADR-017 — Amazon Polly for on-demand question audio

**Status:** Proposed

**Date:** 2026-10-03

**Decision owners:** Family Learning Games

**Applies to:** v0.8+

---

## Context

The application is used by young children, including users who may not yet read fluently.

FASE 8 requires audio support.

The application needs a way to read:

- the question;
- the visible answer options.

Possible strategies include:

1. browser `speechSynthesis`;
2. pre-generated audio files;
3. backend text-to-speech through Amazon Polly.

Browser speech synthesis has almost no backend cost, but voice availability, language quality and behavior depend on device/browser/OS.

Pre-generating all audio increases deployment/content management and cannot naturally cover newly generated games.

Amazon Polly provides a server-controlled text-to-speech capability that can work for both seeded and generated games.

The current backend is serverless and low-volume, so on-demand synthesis plus caching fits the existing operating model.

---

## Decision

v0.8 will use **Amazon Polly** behind an Application `SpeechSynthesizer` port.

Audio is synthesized **on explicit user request**.

The browser calls:

```http
POST /games/{gameId}/questions/{questionId}/audio
```

The browser does not send arbitrary text.

The backend:

1. loads the persisted game;
2. resolves the requested question;
3. builds plain speech text from the question and its answer options;
4. calculates a deterministic cache key;
5. checks private S3 audio cache;
6. invokes Polly only on cache miss;
7. stores MP3 output;
8. returns a short-lived signed read URL.

---

## Rationale

### 1. Consistent provider-controlled speech

Speech quality does not depend on whichever local voice happens to be installed on the child's device.

### 2. Generated games work automatically

Any valid persisted question can be spoken without preparing files in advance.

### 3. Browser cannot abuse the API as arbitrary TTS

Because the endpoint accepts IDs rather than free text, the backend controls synthesized content and maximum length.

### 4. Cost remains bounded

Audio is generated only when requested and identical content can be reused from S3.

### 5. Provider independence

Application depends on `SpeechSynthesizer`, not directly on the Polly SDK.

A later provider change does not require Domain changes.

---

## Speech content

One audio object should contain:

```text
question
+ answer option 1
+ answer option 2
+ answer option 3
+ answer option 4
```

The answer order must exactly match the UI order.

The speech must never reveal `isCorrect`.

---

## Plain text, not SSML

v0.8 uses Polly plain-text synthesis.

SSML is deferred because:

- it increases validation complexity;
- AI/user-authored SSML could create unexpected behavior;
- the initial requirement is simple read-aloud accessibility.

A future ADR may introduce controlled server-generated SSML.

---

## Configuration

The following belong to Infrastructure/deployment configuration, not Domain:

```text
POLLY_VOICE_ID
POLLY_ENGINE
POLLY_LANGUAGE_CODE
POLLY_OUTPUT_FORMAT
AUDIO_URL_TTL_SECONDS
AUDIO_CACHE_VERSION
```

Exact defaults should be tested on the target devices and language before production deployment.

`AUDIO_CACHE_VERSION` is part of cache identity so changing voice/prosody policy can invalidate old audio without deleting it synchronously.

---

## Failure policy

Audio is non-critical.

If Polly or S3 fails:

- return a safe media error;
- show a non-blocking frontend message;
- do not alter the game/session;
- allow the player to continue answering normally.

No audio failure should become a game-generation or game-session failure.

---

## Observability

Record structured events for:

```text
QUESTION_AUDIO_REQUESTED
QUESTION_AUDIO_CACHE_HIT
QUESTION_AUDIO_CACHE_MISS
QUESTION_AUDIO_SYNTHESIZED
QUESTION_AUDIO_FAILED
```

Useful fields include:

- correlation ID;
- game/question opaque ID;
- cache outcome;
- provider duration;
- safe error category.

Do not log:

- MP3 bytes;
- signed URLs in full;
- correct-answer metadata.

---

## Security

The backend Lambda receives only required Polly permission.

The public endpoint must not accept:

- `text`;
- `ssml`;
- arbitrary `voiceId`;
- arbitrary output format.

This prevents the endpoint from becoming a general-purpose TTS service.

---

## Consequences

### Positive

- accessible read-aloud experience;
- works for generated and seeded games;
- consistent server-controlled voice selection;
- provider isolated behind a port;
- cache reduces repeated synthesis cost;
- no new Lambda or always-on compute.

### Negative

- first playback on cache miss has network/provider latency;
- additional S3 and Polly cost;
- requires connectivity;
- media URL expires;
- depends on Polly availability.

---

## Alternatives considered

### A. Browser Web Speech API

Rejected as the primary v0.8 solution.

It is attractive for simplicity, but voice availability and behavior vary across browsers/operating systems. It may remain a future fallback, but adding a fallback in v0.8 would create two speech paths and complicate testing.

### B. Ship prerecorded audio

Rejected.

It cannot scale to arbitrary AI-generated questions.

### C. Synthesize all game audio during game generation

Rejected.

It adds unnecessary latency/cost to `POST /games/generate` and would interfere with the v0.7.1 synchronous AI execution budget.

### D. Dedicated audio worker/queue

Rejected for v0.8.

The family-scale workload does not justify SQS/worker infrastructure. If future traffic or latency proves on-demand synthesis insufficient, asynchronous pre-generation can be reconsidered.

---

## Relationship to previous ADRs

This ADR preserves ADR-014 online-first PWA behavior.

It does not modify or supersede the AI generation decisions in ADR-011 or ADR-015.

Question speech is a separate media path and must not consume or alter the Generator/Validator execution-budget policy.
