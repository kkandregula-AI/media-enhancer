const CACHE_NAME = "ai-media-enhancer-v2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  // For API calls, always go to network first and do not cache POSTs here.
  if (request.url.includes("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  // Network-first for HTML and app shell so old UI does not stay stuck.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, copy);
        });
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached || caches.match("/index.html");
      })
  );
});