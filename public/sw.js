// Simple Service Worker for Basic PWA Installability
self.addEventListener("install", () => {
    console.log("Service Worker: Installed");
});

self.addEventListener("activate", () => {
    console.log("Service Worker: Activated");
});

self.addEventListener("fetch", () => {
    // Let the browser do its default thing
});
