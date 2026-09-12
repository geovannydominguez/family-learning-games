/**
 * Deterministic classification rules used by the Service Worker's fetch
 * handler. Kept as plain, unit-testable functions because `public/sw.js`
 * runs outside the TypeScript/bundler pipeline (it must stay a static,
 * dependency-free browser script). `public/sw.js` mirrors this logic in
 * plain JS — keep both in sync when changing either.
 *
 * Scope: PWA delivery only. See ADR-014-pwa-online-first.md. These rules
 * exist to guarantee two invariants:
 *   1. Backend API requests are never served from Cache Storage.
 *   2. Only versioned, owned static caches are ever removed on activate.
 */

export const CACHE_VERSION = "v1";
export const STATIC_CACHE_NAME = `joam-static-${CACHE_VERSION}`;
export const OWNED_CACHE_PREFIX = "joam-static-";
export const OFFLINE_URL = "/offline.html";

const STATIC_PATH_PREFIXES = ["/_next/static/", "/icons/"];
const STATIC_EXACT_PATHS = ["/manifest.webmanifest", "/offline.html", "/favicon.ico"];

/** Frontend static resources the Service Worker is allowed to cache. */
export function isStaticAssetPath(pathname: string): boolean {
  if (STATIC_EXACT_PATHS.includes(pathname)) return true;
  return STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Reserved for same-origin API-shaped routes. No such route exists in this
 * frontend today (the backend always lives on a separate origin — API
 * Gateway/execute-api, never play.joamgames.com), but this keeps the rule
 * explicit in case one is ever introduced under `/api/`.
 */
export function isReservedApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export function isSameOrigin(requestUrl: string, selfOrigin: string): boolean {
  return new URL(requestUrl).origin === selfOrigin;
}

/**
 * The Family Learning Games backend (API Gateway) always lives on a
 * different origin than the frontend. Any cross-origin request is treated
 * as a backend/API request and must stay network-only.
 */
export function isBackendApiRequest(requestUrl: string, selfOrigin: string): boolean {
  return !isSameOrigin(requestUrl, selfOrigin);
}

/**
 * Whether a request is eligible for the Service Worker's static cache
 * strategy at all. `false` means: let the browser handle it as a normal
 * network request, untouched by the Service Worker.
 */
export function isCacheableGetRequest(method: string, requestUrl: string, selfOrigin: string): boolean {
  if (method !== "GET") return false;
  if (!isSameOrigin(requestUrl, selfOrigin)) return false;
  const { pathname } = new URL(requestUrl);
  if (isReservedApiPath(pathname)) return false;
  return isStaticAssetPath(pathname);
}

/** Only caches owned by this app (`joam-static-*`) and not the current version are obsolete. */
export function isObsoleteOwnedCache(cacheName: string, currentCacheName: string): boolean {
  return cacheName.startsWith(OWNED_CACHE_PREFIX) && cacheName !== currentCacheName;
}
