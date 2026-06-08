/*
 * Service Worker untuk Smart ERP PWA.
 * Strategy: Network-first untuk halaman/API, Cache-first untuk static assets.
 * Mendukung offline fallback page.
 */

const CACHE_NAME = "smart-erp-v3";
const STATIC_CACHE = "smart-erp-static-v3";

const STATIC_ASSETS = [
  "/offline.html",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

// Install: cache static assets dan offline page
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: hapus cache lama
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== STATIC_CACHE)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first untuk navigasi, cache-first untuk static
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Skip chrome-extension and other non-http
  if (!request.url.startsWith("http")) return;

  // Navigation requests (halaman HTML)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache halaman yang berhasil
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
          return response;
        })
        .catch(() => {
          // Offline: coba dari cache, fallback ke offline page
          return caches.match(request).then((cached) => {
            return cached || caches.match("/offline.html");
          });
        })
    );
    return;
  }

  // Static assets (JS, CSS, images, fonts)
  if (
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "image" ||
    request.destination === "font" ||
    request.url.includes("/icons/") ||
    request.url.includes("/_next/static/")
  ) {
    // Stale-while-revalidate: sajikan dari cache bila ada, tapi selalu
    // fetch versi terbaru di background dan perbarui cache. Mencegah
    // chunk lama (tema lama) menempel setelah deploy/perubahan source.
    event.respondWith(
      caches.match(request).then((cached) => {
        const networkFetch = fetch(request)
          .then((response) => {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, clone);
            });
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // API dan lainnya: network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});
