"use client";

import { useEffect } from "react";

import { registerServiceWorker } from "./registerServiceWorker";

/**
 * Mounted once from the root layout. Renders nothing — it only registers
 * `/sw.js` (production only) as a progressive enhancement. Any failure is
 * swallowed by `registerServiceWorker`; the rest of the application never
 * depends on this succeeding.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    void registerServiceWorker({
      isProduction: process.env.NODE_ENV === "production",
      hasServiceWorkerSupport: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    });
  }, []);

  return null;
}
