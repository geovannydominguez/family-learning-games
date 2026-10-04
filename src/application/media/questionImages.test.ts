import assert from "node:assert/strict";
import test from "node:test";

import { isValidQuestionImage } from "../../domain/game/questionMedia.ts";
import type { MediaEvent } from "./mediaEvents.ts";
import type { MediaObjectStore } from "./ports.ts";
import { CatalogQuestionImageResolver } from "./questionImages.ts";

function store(fail = false): MediaObjectStore & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    exists: async () => true,
    put: async () => {},
    createReadUrl: async (key, ttl) => {
      if (fail) throw Object.assign(new Error("arn:aws:s3:::private-bucket"), { name: "CredentialsProviderError" });
      signed.push(key);
      return `https://signed.example/${key}?X-Amz-Expires=${ttl}`;
    },
  };
}

const catalog = [{ assetId: "animals/dolphin-01", objectKey: "images/animals/dolphin-01.webp" }];

test("image metadata validation accepts logical references and rejects URLs, data URIs, HTML and unbounded alt text", () => {
  assert.equal(isValidQuestionImage({ assetId: "animals/dolphin-01", altText: "Un delfín nadando en el océano" }), true);
  for (const assetId of ["https://cdn.example/dolphin.png", "data:image/png;base64,AAA", "javascript:alert(1)", "s3://bucket/images/a.webp", "images/../secret", "Animals/Dolphin", "", "a".repeat(129)]) {
    assert.equal(isValidQuestionImage({ assetId, altText: "Un delfín" }), false, assetId);
  }
  for (const altText of ["", "   ", "<img src=x onerror=alert(1)>", "ver https://example.com", "javascript:alert(1)", "x".repeat(201)]) {
    assert.equal(isValidQuestionImage({ assetId: "animals/dolphin-01", altText }), false, altText);
  }
  assert.equal(isValidQuestionImage(undefined), false);
});

test("a catalogued image resolves to a short-lived URL and only public fields", async () => {
  const media = store();
  const events: MediaEvent[] = [];
  const resolver = new CatalogQuestionImageResolver(catalog, media, { urlTtlSeconds: 900, logEvent: (event) => events.push(event) });
  const image = await resolver.resolve({ assetId: "animals/dolphin-01", altText: " Un delfín nadando " });
  assert.deepEqual(image, { url: "https://signed.example/images/animals/dolphin-01.webp?X-Amz-Expires=900", altText: "Un delfín nadando" });
  assert.deepEqual(Object.keys(image!).sort(), ["altText", "url"]);
  assert.deepEqual(events.map((event) => event.event), ["QUESTION_IMAGE_RESOLVED"]);
  assert.equal(JSON.stringify(events).includes("https://"), false);
});

test("missing, unknown, invalid or failing images degrade to no image (never throw)", async () => {
  const events: MediaEvent[] = [];
  const resolver = new CatalogQuestionImageResolver(catalog, store(), { urlTtlSeconds: 900, logEvent: (event) => events.push(event) });
  assert.equal(await resolver.resolve(undefined), undefined);
  assert.equal(await resolver.resolve({ assetId: "animals/unknown", altText: "Desconocido" }), undefined);
  assert.equal(await resolver.resolve({ assetId: "https://evil.example/x.png", altText: "x" }), undefined);

  const failing = new CatalogQuestionImageResolver(catalog, store(true), { urlTtlSeconds: 900, logEvent: (event) => events.push(event) });
  assert.equal(await failing.resolve({ assetId: "animals/dolphin-01", altText: "Un delfín" }), undefined);
  assert.deepEqual(events.map((event) => event.event), ["QUESTION_IMAGE_MISSING", "QUESTION_IMAGE_MISSING", "QUESTION_IMAGE_FAILED"]);
  assert.equal(JSON.stringify(events).includes("private-bucket"), false);
});

test("the controlled catalog only accepts images/ objects in supported formats", () => {
  for (const objectKey of ["audio-cache/v1/x.mp3", "images/a.gif", "images/../audio-cache/x.webp", "https://cdn/x.png"]) {
    assert.throws(() => new CatalogQuestionImageResolver([{ assetId: "a", objectKey }], store(), { urlTtlSeconds: 900 }), objectKey);
  }
  assert.throws(() => new CatalogQuestionImageResolver([{ assetId: "https://x", objectKey: "images/a.png" }], store(), { urlTtlSeconds: 900 }));
});
