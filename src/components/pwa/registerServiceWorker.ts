/**
 * Service Worker registration, kept as small, dependency-free, testable
 * functions so registration decisions and failure handling don't rely on
 * exercising a real browser. Progressive enhancement (NFR-02): normal
 * application usage must never depend on this succeeding.
 */

export interface ServiceWorkerEnv {
  isProduction: boolean;
  hasServiceWorkerSupport: boolean;
}

/**
 * Registration only happens in production. A persistent Service Worker
 * during `npm run dev` would serve cached/stale files and create confusing,
 * hard-to-reproduce local issues unrelated to the code being changed.
 */
export function shouldRegisterServiceWorker(env: ServiceWorkerEnv): boolean {
  return env.isProduction && env.hasServiceWorkerSupport;
}

export type ServiceWorkerRegistrationOutcome = "registered" | "skipped" | "failed";

/**
 * Registers `/sw.js` when appropriate. Never throws: any failure (browser
 * refuses registration, network error, unsupported context, ...) is
 * swallowed and reported as `"failed"` so the caller can treat it as a
 * no-op — the web app must keep working normally either way.
 */
export async function registerServiceWorker(
  env: ServiceWorkerEnv,
  register: (scriptUrl: string) => Promise<unknown> = (scriptUrl) => navigator.serviceWorker.register(scriptUrl),
): Promise<ServiceWorkerRegistrationOutcome> {
  if (!shouldRegisterServiceWorker(env)) return "skipped";
  try {
    await register("/sw.js");
    return "registered";
  } catch {
    return "failed";
  }
}
