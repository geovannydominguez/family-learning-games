/**
 * Family Learning Games — Service Worker
 *
 * Scope: PWA delivery only (installability, static resource caching, offline
 * fallback, cache lifecycle). No game/player/business logic lives here.
 * See docs/architecture/ADR-014-pwa-online-first.md.
 *
 * The classification rules below mirror the unit-tested pure functions in
 * src/infrastructure/pwa/cacheClassification.ts. This file must stay a
 * plain, dependency-free static asset (served from public/), so the logic
 * is duplicated here in vanilla JS rather than imported — keep both in sync
 * when changing either.
 *
 * Cache policy (non-negotiable): backend API requests are never served from
 * Cache Storage. The Family Learning Games API always lives on a different
 * origin than the frontend (API Gateway/execute-api, never
 * play.joamgames.com), so any cross-origin request is left untouched here
 * and goes straight to the network.
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE_NAME = `joam-static-${CACHE_VERSION}`;
const OWNED_CACHE_PREFIX = "joam-static-";
const OFFLINE_URL = "/offline.html";

const STATIC_PATH_PREFIXES = ["/_next/static/", "/icons/"];
const STATIC_EXACT_PATHS = ["/manifest.webmanifest", "/offline.html", "/favicon.ico"];

function isStaticAssetPath(pathname) {
  if (STATIC_EXACT_PATHS.includes(pathname)) return true;
  return STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener("install", (event) => {
  // Take over as soon as possible; combined with clients.claim() in
  // activate(), this keeps the update lifecycle simple and predictable
  // (no in-app "new version available" prompt required for v0.7).
  self.skipWaiting();

  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) =>
      // { cache: "reload" } bypasses the HTTP cache so a redeployed offline
      // page is always fetched fresh when a new Service Worker installs.
      cache.add(new Request(OFFLINE_URL, { cache: "reload" })),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            // Only ever remove caches this app owns and that are not the
            // current version. Never touch unrelated browser/extension caches.
            .filter((name) => name.startsWith(OWNED_CACHE_PREFIX) && name !== STATIC_CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever act on GET requests. Everything else (POST/PUT/DELETE —
  // including every mutating backend call) passes straight through.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin => backend/API request. Never intercepted, never cached.
  if (url.origin !== self.location.origin) return;

  // Defense in depth: keep same-origin API-shaped routes network-only even
  // if one is ever introduced under /api/. None exist today.
  if (url.pathname.startsWith("/api/")) return;

  // Page navigations: always try the network first. Only fall back to the
  // offline page when the network is truly unreachable (fetch rejects) —
  // never for a normal HTTP error response from the server.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Everything else that isn't a known static resource is left untouched.
  if (!isStaticAssetPath(url.pathname)) return;

  // Static, versioned/immutable frontend resources: cache-first, refresh on
  // miss. This is the only category of resource this Service Worker treats
  // as cacheable application data — see ADR-014-pwa-online-first.md.
  event.respondWith(
    caches.open(STATIC_CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }),
  );
});
