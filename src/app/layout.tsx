import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });

export const metadata: Metadata = {
  title: { default: "RoClicks Analytics", template: "%s | RoClicks Analytics" },
  description: "Self-hosted analytics for Roblox games.",
  robots: { index: false },
};

export const viewport: Viewport = { themeColor: "#0a0e14" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body className="flex min-h-dvh flex-col">{children}</body>
    </html>
  );
}
