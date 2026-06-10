/*
 * Tujuan: Root layout Next.js untuk font, tema awal, toaster, dan warm luxury background aplikasi.
 * Caller: Next.js App Router root.
 * Dependensi: next/font, sonner, ThemeSwitcher applyStoredThemeScript, app/globals.css.
 * Main Functions: RootLayout, metadata, ambient background layer, suppress theme hydration warning.
 * Side Effects: Inject script tema dari localStorage sebelum paint dan render toaster global.
 */
import type { Metadata, Viewport } from "next";
import { Exo_2, Rajdhani, Share_Tech_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { applyStoredThemeScript } from "@/components/ThemeSwitcher";
import "./globals.css";

// Font khusus tema "neon" (data-theme="neon"); tidak dipakai tema warm.
// Font sans/mono dasar memakai fallback CSS variable di globals.css (:root).
const exo2 = Exo_2({
  variable: "--font-exo2",
  subsets: ["latin"],
  weight: ["600", "800"],
  style: ["normal", "italic"],
});

const rajdhani = Rajdhani({
  variable: "--font-rajdhani",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const shareTechMono = Share_Tech_Mono({
  variable: "--font-tech-mono",
  subsets: ["latin"],
  weight: "400",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#c79a3f",
};

export const metadata: Metadata = {
  title: "Smart ERP - Accurate Online",
  description: "Headless Accurate Frontend - Dynamic execution of Accurate Online endpoints",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Smart ERP",
  },
  icons: {
    icon: [
      { url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applyStoredThemeScript }} />
      </head>
      <body
        className={`${exo2.variable} ${rajdhani.variable} ${shareTechMono.variable} antialiased bg-[#0f1015] text-slate-200 min-h-screen selection:bg-indigo-500/30 selection:text-indigo-200 overflow-x-hidden`}
      >
        <div className="fixed inset-0 -z-10 bg-[radial-gradient(ellipse_70%_60%_at_50%_-15%,rgba(242,210,138,0.34),rgba(255,255,255,0))]"></div>
        <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_760px_at_100%_180px,rgba(199,154,63,0.18),transparent)]"></div>
        <div className="fixed inset-0 -z-10 bg-[linear-gradient(180deg,rgba(255,255,255,0.28),rgba(255,255,255,0)_42%)]"></div>
        <Toaster position="top-right" richColors theme="light" toastOptions={{ className: 'bg-[#1a1c23]/90 backdrop-blur-xl border-white/10 text-slate-200 shadow-2xl' }} />
          {children}
      </body>
    </html>
  );
}
