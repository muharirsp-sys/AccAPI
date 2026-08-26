// Service Worker AccAPI — VERSION-based cache invalidation, no API caching.
// Increment VERSION on every deploy to auto-purge stale caches.
const VERSION = "accapi-v4";
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;

const PRECACHE = ["/offline.html", "/icons/icon-192x192.png", "/icons/icon-512x512.png"];

// Routes that must never be cached (dynamic data, auth-gated).
function isBypass(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/fastapi/") ||
    url.pathname.startsWith("/pdf/") ||
    url.pathname.startsWith("/uploads/") ||
    url.pathname === "/login" ||
    url.pathname === "/forgot-password"
  );
}

function isStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/")
  );
}

// Install: pre-cache shell assets, then activate immediately.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

// Activate: purge any cache that doesn't belong to this VERSION, then claim tabs.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function offlineResponse() {
  return new Response("Offline", { status: 503, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (!req.url.startsWith("http")) return;

  const url = new URL(req.url);

  // Bypass: let API / dynamic routes go straight to the network, no caching.
  if (url.origin === self.location.origin && isBypass(url)) return;

  // Static assets (_next/static, icons): stale-while-revalidate.
  if (isStatic(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          // ponytail: respondWith WAJIB dapat Response. undefined = "FetchEvent resulted in
          // a network error response" di console, menutupi error asli.
          .catch(() => hit || offlineResponse());
        return hit || fetchPromise;
      })
        // Cache storage bisa gagal dibuka (quota / private mode) — jangan sampai
        // promise-nya reject, respondWith akan jadi network error.
        .catch(() => fetch(req)),
    );
    return;
  }

  // Navigation: network-first, fallback to cached page then offline shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Clone synchronously before any async op — body consumed after return.
          const clone = res.clone();
          caches.open(PAGE_CACHE).then((c) => c.put(req, clone));
          return res;
        })
        .catch(
          async () =>
            (await caches.match(req)) ||
            (await caches.match("/offline.html")) ||
            offlineResponse(),
        ),
    );
    return;
  }

  // Everything else: biarkan browser yang menangani — tanpa respondWith, error jaringan
  // muncul apa adanya, bukan disamarkan jadi "network error response" dari SW.
});
