# Family Learning Games — Requirements v0.8

**Version:** v0.8

**Phase:** FASE 8 — Audio / imágenes

**Status:** Proposed for implementation

**Date:** 2026-10-03

**Baseline:** v0.7.1

---

## 1. Objective

v0.8 improves accessibility and engagement for young children by adding:

- on-demand spoken questions and answer options;
- optional controlled educational images.

Media must remain optional and must not compromise the reliability, safety or simplicity of the existing game flow.

---

## 2. Functional requirements

### FR-0801 — Listen to a question

The question screen must provide an explicit action that lets the player listen to the current question.

### FR-0802 — Read answer options

The generated audio must include the currently displayed answer options in the same order shown by the UI.

### FR-0803 — No autoplay

Audio must not automatically start when:

- the page opens;
- a question changes;
- a game starts.

Playback starts only after explicit user interaction.

### FR-0804 — Replay

After audio is available, the user must be able to replay it.

### FR-0805 — Optional question image

A question may include one optional image.

Questions without images remain fully valid.

### FR-0806 — Image alt text

Every learning image must have non-empty, bounded alternative text.

### FR-0807 — Media is non-blocking

Audio or image failure must never prevent:

- selecting an answer;
- submitting an answer;
- continuing to the next question;
- completing the game.

### FR-0808 — Persist logical image reference

Persist only a logical image reference such as:

```text
assetId
altText
```

Do not persist signed S3 URLs.

### FR-0809 — Controlled images only

v0.8 must accept only images from the application-controlled media catalog.

Arbitrary external HTTP/HTTPS image URLs are not supported.

### FR-0810 — On-demand audio

Audio is generated/resolved only when the user requests it.

The normal game/session APIs must not synthesize audio automatically.

### FR-0811 — Audio cache

Repeated requests for identical speech content/configuration should reuse a cached audio object rather than calling Polly again.

### FR-0812 — Server-derived speech text

The audio endpoint must receive game/question identifiers, not arbitrary speech text.

The backend derives speech content from the persisted game/question.

### FR-0813 — Existing games remain valid

Games created before v0.8 and games without media must continue to play without migration requirements.

### FR-0814 — Generated games do not require images

AI-generated games remain successful even when no controlled image is available.

### FR-0815 — No answer leakage

Audio, image metadata and public media DTOs must not reveal `isCorrect` or otherwise expose the correct answer before the player responds.

---

## 3. API requirements

### FR-0820 — Audio endpoint

Provide:

```http
POST /games/{gameId}/questions/{questionId}/audio
```

The body must be empty, `null`, or `{}`; any field is rejected with `400 INVALID_REQUEST`.

The request must not accept:

```json
{
  "text": "...",
  "ssml": "...",
  "voiceId": "..."
}
```

from the client.

### FR-0821 — Audio response

v0.8 reuses the existing HTTP contract: success bodies are endpoint-specific JSON and errors are `{ "error": { "code", "message" } }`. No `{ "code", "message", "data" }` envelope is introduced.

Successful response (`200 OK`):

```json
{
  "audioUrl": "...",
  "expiresAt": "..."
}
```

Errors: `400 INVALID_REQUEST`, `404 RESOURCE_NOT_FOUND`, `422 QUESTION_AUDIO_UNSUPPORTED`, `502 QUESTION_AUDIO_FAILED`, `503 QUESTION_AUDIO_DISABLED` (see ARCHITECTURE-V0.8 §8.1).

### FR-0822 — Missing game/question

Unknown `gameId` or `questionId` must return a safe not-found contract: `404 { "error": { "code": "RESOURCE_NOT_FOUND", "message": "Game was not found." | "Question was not found." } }`.

### FR-0823 — Provider failure

A Polly/S3 failure must return a safe provider/media error without exposing AWS implementation details: `502 { "error": { "code": "QUESTION_AUDIO_FAILED", "message": "Question audio is temporarily unavailable." } }`.

### FR-0824 — Optional public image field

Public game/session question DTOs may expose, additively:

```json
{
  "media": {
    "image": {
      "url": "...",
      "altText": "..."
    }
  }
}
```

The entire `media` property is optional. The pre-existing public `image?: string` field (since v0.2) keeps its type and pass-through behavior for backward compatibility and must not be reused for v0.8 images.

### FR-0825 — Expiring media URLs

Private media URLs returned to the browser must be short-lived.

A signed URL must not be treated as a stable game identifier.

---

## 4. Domain and application requirements

### FR-0830 — Domain independence

Domain must not import or reference:

- AWS SDK;
- S3;
- Polly;
- bucket names;
- object keys;
- signed URLs;
- MP3;
- CDK.

### FR-0831 — Provider-independent speech port

Application must depend on a `SpeechSynthesizer`-style abstraction rather than `PollyClient`.

### FR-0832 — Provider-independent media storage port

Application must depend on a `MediaObjectStore`-style abstraction rather than `S3Client`.

### FR-0833 — Logical image identity

Image identity in Domain must be provider-independent.

`assetId` must not be an S3 URL.

### FR-0834 — Optional media model

Adding media must be backward compatible with existing persisted `Game` documents.

### FR-0835 — No parallel game domain

Do not introduce:

- `AudioGame`;
- `ImageGame`;
- `MultimediaGame`;
- a separate media game/session aggregate.

The same `Game` and `GameSession` remain authoritative.

---

## 5. Audio requirements

### FR-0840 — Spoken content

The synthesized text must contain:

1. the question;
2. each answer option with a deterministic label/number.

### FR-0841 — Display order

Audio must follow the answer order currently presented to the player.

It must not regenerate or reshuffle answers.

### FR-0842 — Correct answer remains hidden

The speech text must never say or imply which answer is correct.

### FR-0843 — Plain text only

v0.8 uses plain-text speech synthesis.

Do not accept model-authored or user-authored SSML.

### FR-0844 — Bounded input

The backend must enforce a maximum synthesized-text length before calling Polly.

### FR-0845 — Configurable voice

Voice/language configuration belongs to deployment/infrastructure configuration.

It must not be hardcoded in Domain.

v0.8 uses one fixed speech profile: voice `Lupe`, engine `neural`, language `es-US`, output `mp3`. Spoken labels such as `Opción N` are Spanish. No other language or Spanish variant (`es-MX`, `es-ES`) can be configured; voice/language selection, translations and i18n are out of scope.

### FR-0846 — Deterministic cache identity

The audio cache key must include enough information to change when:

- spoken text changes;
- language changes;
- effective voice configuration version changes.

### FR-0847 — Opaque cache key

Do not put raw question text, topic or player names in the S3 object key.

### FR-0848 — Cache miss behavior

On cache miss:

1. synthesize through Polly;
2. write the audio object;
3. return a signed read URL.

### FR-0849 — Cache hit behavior

On cache hit:

- do not invoke Polly;
- return a new short-lived read URL for the existing object.

---

## 6. Image requirements

### FR-0850 — Controlled catalog

Every `assetId` must resolve through application-controlled configuration/catalog logic.

### FR-0851 — Unknown asset

An unknown/missing image asset must degrade to no image rather than fail the game.

### FR-0852 — Safe metadata

Image metadata must have bounded lengths and must reject:

- raw HTML;
- JavaScript URLs;
- data URIs;
- arbitrary external URLs.

### FR-0853 — No AI image generation

v0.8 does not call a runtime image-generation model.

### FR-0854 — No image URLs from Claude

The existing Generator/Validator must not be expanded to output remote image URLs.

### FR-0855 — Educational relevance

Curated images should be directly relevant to the question/topic and suitable for children.

### FR-0856 — Avoid answer leakage

If the image itself would trivially reveal the answer in a question not intended as visual recognition, do not attach that image.

---

## 7. S3 requirements

### FR-0860 — Dedicated media bucket

Provision one S3 bucket dedicated to Family Learning Games media.

### FR-0861 — Private by default

The bucket must have public access blocked.

### FR-0862 — Encryption

Objects must use server-side encryption supported by the project deployment standard.

### FR-0863 — TLS

Bucket access should enforce secure transport where supported by the current IaC conventions.

### FR-0864 — Least privilege

The backend Lambda may access only the required media bucket actions/prefixes.

### FR-0865 — Audio lifecycle

Derived `audio-cache/` objects may expire automatically after the configured cache period.

### FR-0866 — Image retention

The audio cache lifecycle rule must not expire curated `images/` assets.

Stack removal is environment-dependent: the development environment (default `environment=dev`) deletes and empties the bucket on `cdk destroy` (`DESTROY` + `autoDeleteObjects`); a production environment (`prod`/`production`) retains it.

### FR-0867 — No browser AWS credentials

The browser must never receive AWS access keys or use the AWS SDK with privileged credentials.

---

## 8. PWA/frontend requirements

### FR-0870 — Online-first remains valid

v0.8 must not change the PWA to offline-first.

### FR-0871 — Dynamic media not permanently cached

The Service Worker must not permanently cache expiring signed media URLs.

### FR-0872 — Loading feedback

The Listen action must provide a clear loading state.

### FR-0873 — Duplicate request protection

Repeated rapid clicks while the first audio request is pending must not generate concurrent duplicate requests.

### FR-0874 — Audio error UX

A synthesis/playback error must be shown as a small non-blocking message.

### FR-0875 — Responsive image

Question images must render correctly on mobile, tablet and desktop.

### FR-0876 — Touch usability

Audio controls must meet the project's large-touch-target design principle.

---

## 9. Security requirements

### NFR-0801 — No general-purpose TTS proxy

The API must not expose a public endpoint that synthesizes arbitrary client-provided text.

### NFR-0802 — Signed URL secrecy in logs

Do not log complete signed URLs.

### NFR-0803 — No hidden answer metadata

Do not expose correct-answer metadata in audio/image contracts.

### NFR-0804 — Least-privilege IAM

Polly and S3 permissions must be scoped to the minimum actions/resources needed.

### NFR-0805 — Safe errors

AWS/provider errors must be translated into safe application errors.

### NFR-0806 — No public bucket

A deployment that makes the media bucket public must fail review/tests.

---

## 10. Reliability requirements

### NFR-0810 — Core game independence

The quiz must remain playable when every media dependency is unavailable.

### NFR-0811 — No changes to AI generation budget

The v0.7.1 Generator/Validator execution-budget behavior must not be weakened or reused incorrectly for media operations.

### NFR-0812 — Bounded Polly request

The Polly integration must use finite SDK retry/timeout behavior consistent with the existing backend runtime constraints.

### NFR-0813 — No long-running image work

v0.8 must not add image inference to the synchronous Lambda path.

---

## 11. Observability requirements

### NFR-0820 — Structured media events

Log structured events for:

- audio requested;
- cache hit;
- cache miss;
- synthesis success/failure;
- image resolved/missing/failure.

### NFR-0821 — Correlation

Media events must use the existing request correlation approach.

### NFR-0822 — Safe payload logging

Logs should not include:

- MP3 bytes;
- complete signed URLs;
- hidden answer metadata;
- secrets.

---

## 12. Performance requirements

### NFR-0830 — Cache hit

A cached audio request should require no Polly invocation.

Two concurrent cache-miss requests may each invoke Polly once; this is an accepted v0.8 limitation (deterministic result, bounded cost) and must not be solved with locks, queues or extra tables.

### NFR-0831 — Page interaction

Loading media must not block answer controls or question navigation.

### NFR-0832 — Lazy image loading

Images should be loaded only when useful for the visible/current UI.

### NFR-0833 — Bounded object size

Curated image assets must have a defined maximum file size and supported format set.

Recommended initial formats:

```text
webp
png
jpeg
```

Prefer WebP when practical.

---

## 13. Cost requirements

### NFR-0840 — Pay-per-use

Do not add always-on compute for v0.8.

### NFR-0841 — Reuse audio

Cache synthesized audio to reduce repeated Polly cost.

### NFR-0842 — No runtime image inference cost

No runtime image-generation service is introduced in v0.8.

---

## 14. Compatibility requirements

### NFR-0850 — Existing APIs

Existing v0.7.1 API behaviors must remain compatible unless explicitly extended with optional fields.

### NFR-0851 — Existing DynamoDB data

No mandatory migration of existing games is required.

### NFR-0852 — Existing PWA

Manifest/install/offline fallback behavior from v0.7 remains valid.

### NFR-0853 — Existing AI pipeline

Generator/Validator contracts remain unchanged unless a purely backward-compatible internal adjustment is required.

The AI pipeline must not become responsible for media URLs.

---

## 15. Acceptance criteria

v0.8 is complete when all of the following are true:

1. A user can play an existing text-only game exactly as before.
2. A user can request audio for a question.
3. The audio contains the question plus answers in displayed order.
4. Replaying the same unchanged content can use cached audio.
5. The browser never sends arbitrary speech text to the backend.
6. A question with a controlled image displays it with valid alt text.
7. A question without an image remains visually and functionally correct.
8. Media failures do not block gameplay.
9. The S3 media bucket is private.
10. Signed URLs are short-lived and are not persisted.
11. No AI image generation exists.
12. No second backend Lambda exists.
13. No new DynamoDB table exists.
14. v0.7.1 AI generation quality/runtime tests still pass.
15. PWA installability and online-first behavior still pass.
16. `npm run lint` passes.
17. `npx tsc --noEmit` passes.
18. `npm test` passes.
19. `npm run build` passes.
20. `npx cdk synth` passes.
21. `git diff --check` passes.

---

## 16. Explicitly out of scope

The following are not requirements for v0.8:

- AI-generated images;
- remote image search;
- user image uploads;
- family photos;
- avatars;
- microphone input;
- speech recognition;
- voice commands;
- custom voices;
- voice cloning;
- audio streaming;
- offline dynamic-media cache;
- media CDN;
- authentication changes;
- multiplayer;
- SQS;
- EventBridge;
- Step Functions.
