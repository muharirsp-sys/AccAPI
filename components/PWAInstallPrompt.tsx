/*
 * Tujuan: Banner ajakan memasang Ruang Kerja sebagai PWA di perangkat pengguna.
 * Caller: app/(dashboard)/layout.tsx (di luar gerbang klien SidebarLayout).
 * Dependensi: event beforeinstallprompt, localStorage, komponen Fiori (Button, token).
 * Main Functions: PWAInstallPrompt.
 * Side Effects: Menampilkan banner pasang dan menyimpan status "Nanti" ke localStorage.
 */
"use client";

import { useState, useEffect } from "react";
import { Download, X } from "lucide-react";
import { fioriClass } from "@/components/fiori/Scope";
import { Button } from "@/components/fiori/core";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // localStorage bisa melempar (izin situs/mode privat) — tanpa try/catch seluruh layout dashboard jatuh ke global-error (peninjau B FK-MSM3 R-6).
    let dismissed: string | null = null;
    try { dismissed = localStorage.getItem("pwa-install-dismissed"); } catch { /* anggap belum dismiss */ }
    if (dismissed) return;

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
    try { localStorage.setItem("pwa-install-dismissed", "true"); } catch { /* tidak tersimpan: banner bisa muncul lagi */ }
  };

  if (!showPrompt) return null;

  // Di ponsel banner berdiri di atas navigasi bawah shell (±60 px), tidak menutupinya.
  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 md:bottom-6 md:left-auto md:right-6 md:w-[380px]" role="region" aria-label="Pasang aplikasi">
      <div className={`${fioriClass} fi-panel`} style={{ gridTemplateColumns: "auto minmax(0,1fr) auto", alignItems: "start", boxShadow: "var(--shadow-2)" }}>
        <span className="fi-tile-ico" aria-hidden><Download className="fi-icon" /></span>
        <div className="grid gap-1">
          <p className="fi-title-3">Pasang Ruang Kerja di perangkat</p>
          <p className="fi-small text-ink-muted">Buka lebih cepat dari layar utama. Tetap butuh koneksi untuk mengirim data ke Accurate.</p>
          <div className="fi-btnrow mt-2">
            <Button variant="primary" onClick={handleInstall}>Pasang</Button>
            <Button variant="tertiary" onClick={handleDismiss}>Nanti</Button>
          </div>
        </div>
        <Button variant="icon" onClick={handleDismiss} aria-label="Tutup"><X className="fi-icon" aria-hidden /></Button>
      </div>
    </div>
  );
}
