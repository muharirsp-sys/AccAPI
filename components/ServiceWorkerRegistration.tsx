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
    if ("serviceWorker" in navigator) {
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
