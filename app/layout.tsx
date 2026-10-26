/*
 * Tujuan: Root layout Next.js: font isi lama (Geist), tema Surya untuk halaman yang belum dimigrasi + token Fiori, metadata.
 * Caller: Next.js App Router root.
 * Dependensi: next/font, fiori/scheme, globals.css, workspace.css, fiori.css.
 * Main Functions: RootLayout, metadata (judul bawaan; SidebarLayout menyetel judul per menu aktif), viewport.
 * Side Effects: Inject script mode/density Fiori dari localStorage sebelum paint. Toaster ada di app/(dashboard)/layout.tsx
 *   (satu-satunya grup rute yang memakai toast), supaya font Fiori tidak ikut dimuat di rute cetak.
 */
import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
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
  title: "Ruang Kerja CV. Surya Perkasa",
  description: "Ruang kerja operasional CV. Surya Perkasa: order, faktur, promo, klaim, dan pembayaran di atas Accurate Online.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Ruang Kerja",
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
      <body className={`${geist.variable} antialiased min-h-screen overflow-x-hidden`}>
        {children}
      </body>
    </html>
  );
}
