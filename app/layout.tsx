import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { applyStoredThemeScript } from "@/components/ThemeSwitcher";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AOL API Wrapper",
  description: "Dynamic execution of Accurate Online endpoints",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased font-outfit bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-white/90 min-h-screen overflow-x-hidden`}
      >
        <Toaster
          position="top-right"
          richColors
          toastOptions={{
            className: "rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-dark shadow-theme-lg text-gray-800 dark:text-white/90",
          }}
        />
        {children}
      </body>
    </html>
  );
}
