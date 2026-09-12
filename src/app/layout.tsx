import type { Metadata, Viewport } from "next";
import "./globals.css";

import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";

export const metadata: Metadata = {
  title: "Family Learning Games",
  description: "Juegos educativos sencillos para disfrutar en familia.",
  applicationName: "JOAM Games",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "JOAM Games",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  // The Web App Manifest link is added automatically by Next.js because
  // src/app/manifest.ts exists — no manual <link rel="manifest"> needed.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#6d28d9",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
