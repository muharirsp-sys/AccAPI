/*
 * Tujuan: Root layout Next.js: CSS global + token Fiori, metadata, viewport. Font dimuat per pembungkus .fiori (components/fiori/Scope.tsx).
 * Caller: Next.js App Router root.
 * Dependensi: fiori/scheme, globals.css, fiori.css.
 * Main Functions: RootLayout, metadata (judul bawaan; judul per menu aktif dari generateMetadata di app/(dashboard)/layout.tsx), viewport.
 * Side Effects: Inject script mode/density Fiori dari localStorage sebelum paint. Toaster ada di app/(dashboard)/layout.tsx
 *   (satu-satunya grup rute yang memakai toast), supaya font Fiori tidak ikut dimuat di rute cetak.
 */
import type { Metadata, Viewport } from "next";
import { applyStoredSchemeScript } from "@/components/fiori/scheme";
import "./globals.css";
import "./fiori.css";

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
    // Mode terang/gelap Fiori lewat html[data-scheme] (skrip di <head>); tema lama sudah pensiun semuanya.
    <html lang="id-ID" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applyStoredSchemeScript }} />
      </head>
      <body className="antialiased min-h-screen overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
