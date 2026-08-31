import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Learning Games",
  description: "Juegos educativos sencillos para disfrutar en familia.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
