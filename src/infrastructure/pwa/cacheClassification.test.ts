import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CACHE_VERSION,
  OWNED_CACHE_PREFIX,
  STATIC_CACHE_NAME,
  isBackendApiRequest,
  isCacheableGetRequest,
  isObsoleteOwnedCache,
  isReservedApiPath,
  isSameOrigin,
  isStaticAssetPath,
} from "./cacheClassification.ts";

const FRONTEND_ORIGIN = "https://play.joamgames.com";
// Shape used across the codebase for NEXT_PUBLIC_GAME_API_BASE_URL (see .env.example).
const BACKEND_ORIGIN = "https://abc123.execute-api.us-east-1.amazonaws.com";

test("STATIC_CACHE_NAME embeds the current cache version and owned prefix", () => {
  assert.equal(STATIC_CACHE_NAME, `joam-static-${CACHE_VERSION}`);
  assert.ok(STATIC_CACHE_NAME.startsWith(OWNED_CACHE_PREFIX));
});

test("isStaticAssetPath accepts immutable Next.js assets and PWA resources", () => {
  assert.equal(isStaticAssetPath("/_next/static/chunks/app.abc123.js"), true);
  assert.equal(isStaticAssetPath("/icons/icon-192.png"), true);
  assert.equal(isStaticAssetPath("/manifest.webmanifest"), true);
  assert.equal(isStaticAssetPath("/offline.html"), true);
  assert.equal(isStaticAssetPath("/favicon.ico"), true);
});

test("isStaticAssetPath rejects everything else", () => {
  assert.equal(isStaticAssetPath("/"), false);
  assert.equal(isStaticAssetPath("/game-setup"), false);
  assert.equal(isStaticAssetPath("/api/whatever"), false);
  assert.equal(isStaticAssetPath("/_next/data/build-id/page.json"), false);
});

test("isReservedApiPath only matches /api/ prefixed paths", () => {
  assert.equal(isReservedApiPath("/api/anything"), true);
  assert.equal(isReservedApiPath("/games"), false);
});

test("isSameOrigin compares request origin against the frontend origin", () => {
  assert.equal(isSameOrigin(`${FRONTEND_ORIGIN}/icons/icon-192.png`, FRONTEND_ORIGIN), true);
  assert.equal(isSameOrigin(`${BACKEND_ORIGIN}/game-setup`, FRONTEND_ORIGIN), false);
});

test("isBackendApiRequest treats every cross-origin request as backend/API", () => {
  assert.equal(isBackendApiRequest(`${BACKEND_ORIGIN}/game-setup`, FRONTEND_ORIGIN), true);
  assert.equal(isBackendApiRequest(`${BACKEND_ORIGIN}/games/generate`, FRONTEND_ORIGIN), true);
  assert.equal(isBackendApiRequest(`${FRONTEND_ORIGIN}/icons/icon-192.png`, FRONTEND_ORIGIN), false);
});

test("isCacheableGetRequest excludes backend API requests regardless of method", () => {
  assert.equal(isCacheableGetRequest("GET", `${BACKEND_ORIGIN}/game-setup`, FRONTEND_ORIGIN), false);
  assert.equal(isCacheableGetRequest("GET", `${BACKEND_ORIGIN}/games`, FRONTEND_ORIGIN), false);
  assert.equal(isCacheableGetRequest("GET", `${BACKEND_ORIGIN}/players`, FRONTEND_ORIGIN), false);
});

test("isCacheableGetRequest excludes non-GET requests even for static-looking paths", () => {
  assert.equal(isCacheableGetRequest("POST", `${FRONTEND_ORIGIN}/icons/icon-192.png`, FRONTEND_ORIGIN), false);
});

test("isCacheableGetRequest excludes reserved same-origin /api/ paths", () => {
  assert.equal(isCacheableGetRequest("GET", `${FRONTEND_ORIGIN}/api/anything`, FRONTEND_ORIGIN), false);
});

test("isCacheableGetRequest accepts same-origin static GET requests", () => {
  assert.equal(isCacheableGetRequest("GET", `${FRONTEND_ORIGIN}/icons/icon-512.png`, FRONTEND_ORIGIN), true);
  assert.equal(
    isCacheableGetRequest("GET", `${FRONTEND_ORIGIN}/_next/static/chunks/app.js`, FRONTEND_ORIGIN),
    true,
  );
  assert.equal(isCacheableGetRequest("GET", `${FRONTEND_ORIGIN}/manifest.webmanifest`, FRONTEND_ORIGIN), true);
});

test("isCacheableGetRequest rejects same-origin navigation-shaped GETs (not static assets)", () => {
  assert.equal(isCacheableGetRequest("GET", `${FRONTEND_ORIGIN}/`, FRONTEND_ORIGIN), false);
});

test("isObsoleteOwnedCache only flags owned caches from a different version", () => {
  assert.equal(isObsoleteOwnedCache("joam-static-v0", STATIC_CACHE_NAME), true);
  assert.equal(isObsoleteOwnedCache(STATIC_CACHE_NAME, STATIC_CACHE_NAME), false);
});

test("isObsoleteOwnedCache never flags caches it does not own", () => {
  assert.equal(isObsoleteOwnedCache("workbox-precache-v2", STATIC_CACHE_NAME), false);
  assert.equal(isObsoleteOwnedCache("some-other-extension-cache", STATIC_CACHE_NAME), false);
});

test("v0.8: signed private media URLs (audio/images) and the audio API are never cacheable", () => {
  const origin = "https://play.joamgames.com";
  const signedAudio = "https://media.s3.us-east-1.amazonaws.com/audio-cache/v1/abc.mp3?X-Amz-Expires=900&X-Amz-Signature=x";
  const signedImage = "https://media.s3.us-east-1.amazonaws.com/images/animals/dolphin-01.webp?X-Amz-Signature=x";
  for (const url of [signedAudio, signedImage]) {
    assert.equal(isBackendApiRequest(url, origin), true);
    assert.equal(isCacheableGetRequest("GET", url, origin), false);
  }
  assert.equal(isCacheableGetRequest("POST", "https://api.example.com/games/animals/questions/q1/audio", origin), false);
});
