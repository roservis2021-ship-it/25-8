const CACHE_NAME = "admin-shell-v9";
const APP_SHELL = [
  "/admin.html",
  "/styles.css?v=9",
  "/admin.js?v=9",
  "/admin.webmanifest",
  "/config.js",
  "/icons/admin-180.png",
  "/icons/admin-192.png",
  "/icons/admin-512.png",
  "/icons/admin-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);

  if (requestUrl.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/admin.html")));
    return;
  }

  if (event.request.method !== "GET") return;

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
