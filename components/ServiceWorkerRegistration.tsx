/*
 * Tujuan: Registrasi service worker untuk PWA Smart ERP.
 * Caller: app/(dashboard)/layout.tsx atau root layout.
 * Dependensi: navigator.serviceWorker API.
 * Main Functions: ServiceWorkerRegistration.
 * Side Effects: Register/update service worker, log status ke console.
 */
"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Dev: jangan daftarkan service worker. SW cache-first untuk
    // /_next/static menyebabkan chunk lama (tema lama) tetap disajikan
    // setelah logout-login walau source sudah benar. Unregister SW lama
    // dan bersihkan cache agar localhost selalu memakai chunk terbaru.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => {
          void registration.unregister();
        });
      });
      if (typeof caches !== "undefined") {
        caches.keys().then((keys) => {
          keys.forEach((key) => {
            void caches.delete(key);
          });
        });
      }
      return;
    }

    {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration) => {
          // Check for updates setiap 1 jam
          setInterval(() => {
            registration.update();
          }, 60 * 60 * 1000);

          registration.addEventListener("updatefound", () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener("statechange", () => {
                if (
                  newWorker.state === "activated" &&
                  navigator.serviceWorker.controller
                ) {
                  // Ada update baru, bisa tampilkan notifikasi refresh
                  console.log("[SW] New version available");
                }
              });
            }
          });
        })
        .catch((error) => {
          console.error("[SW] Registration failed:", error);
        });
    }
  }, []);

  return null;
}
