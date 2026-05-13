import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
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
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0f1015] text-slate-200 min-h-screen selection:bg-indigo-500/30 selection:text-indigo-200 overflow-x-hidden`}
      >
        <div className="fixed inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.25),rgba(255,255,255,0))]"></div>
        <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_800px_at_100%_200px,#1a1a3a,transparent)]"></div>
        <Toaster position="top-right" richColors theme="dark" toastOptions={{ className: 'bg-[#1a1c23]/90 backdrop-blur-xl border-white/10 text-slate-200 shadow-2xl' }} />
          {children}
      </body>
    </html>
  );
}
