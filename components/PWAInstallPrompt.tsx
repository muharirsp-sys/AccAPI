/*
 * Tujuan: Banner/prompt untuk menginstall Smart ERP sebagai PWA di perangkat user.
 * Caller: SidebarLayout (dashboard).
 * Dependensi: beforeinstallprompt event, localStorage.
 * Main Functions: PWAInstallPrompt.
 * Side Effects: Menampilkan banner install dan menyimpan dismiss state ke localStorage.
 */
"use client";

import { useState, useEffect } from "react";
import { Download, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // Jangan tampilkan kalau user sudah dismiss sebelumnya
    const dismissed = localStorage.getItem("pwa-install-dismissed");
    if (dismissed) return;

    // Jangan tampilkan kalau sudah dalam mode standalone
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setShowPrompt(false);
    }
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    localStorage.setItem("pwa-install-dismissed", "true");
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 md:w-[380px] z-50 animate-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-start gap-3 p-4 rounded-2xl bg-[var(--surface)] border border-[var(--border-strong)] shadow-[var(--luxury-shadow)] backdrop-blur-xl">
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-[#f2d28a] to-[#b77a25] flex items-center justify-center shadow-md">
          <Download size={20} className="text-[#3d2814]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--luxury-text)]">Install Smart ERP</p>
          <p className="text-xs text-[var(--luxury-muted)] mt-0.5 leading-relaxed">
            Akses cepat dari home screen. Bisa dipakai offline.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={handleInstall}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-[#f2d28a] via-[#c79a3f] to-[#7a4e20] text-[#3d2814] shadow-sm hover:shadow-md transition-shadow"
            >
              Install
            </button>
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-[var(--luxury-muted)] hover:text-[var(--luxury-text)] hover:bg-[var(--surface-2)] transition-colors"
            >
              Nanti
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 p-1 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
          aria-label="Tutup"
        >
          <X size={16} className="text-[var(--luxury-subtle)]" />
        </button>
      </div>
    </div>
  );
}
