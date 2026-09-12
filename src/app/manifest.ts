import type { MetadataRoute } from "next";

/**
 * Native Next.js App Router metadata route (Next.js 13.3+/15).
 *
 * This file is automatically served as `/manifest.webmanifest` and Next.js
 * injects the corresponding `<link rel="manifest">` tag itself — no manual
 * wiring is needed in `layout.tsx`. See ADR-014-pwa-online-first.md.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Family Learning Games",
    short_name: "JOAM Games",
    description: "Juegos educativos sencillos para disfrutar en familia.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f3ff",
    theme_color: "#6d28d9",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
