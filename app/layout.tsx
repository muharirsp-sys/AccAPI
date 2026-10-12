/*
 * Tujuan: Root layout Next.js untuk font, tema Surya (isi lama) + token Fiori, dan toaster aplikasi.
 * Caller: Next.js App Router root.
 * Dependensi: next/font, sonner, fiori/scheme, globals.css, workspace.css dan fiori.css.
 * Main Functions: RootLayout, metadata, ambient background layer, suppress theme hydration warning.
 * Side Effects: Inject script mode/density Fiori dari localStorage sebelum paint dan render toaster global.
 */
import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Toaster } from "sonner";
import { applyStoredSchemeScript } from "@/components/fiori/scheme";
import "./globals.css";
import "./workspace.css";
import "./fiori.css";

const geist = Geist({ variable: "--font-workspace", subsets: ["latin"], display: "swap" });

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#004c97",
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
    // Tema lama Office Calm, Neon, dan iOS pensiun (keputusan owner 6 Okt 2026): isi halaman yang belum dimigrasi
    // selalu memakai remap Surya; mode terang/gelap Fiori lewat data-scheme.
    <html lang="id-ID" data-theme="surya" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applyStoredSchemeScript }} />
      </head>
      <body
        className={`${geist.variable} antialiased bg-[#0f1015] text-slate-200 min-h-screen selection:bg-indigo-500/30 selection:text-indigo-200 overflow-x-hidden`}
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
