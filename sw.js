const CACHE_PREFIX = "workout-program-shell-";
const CACHE_VERSION = "v1";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const BASE_URL = new URL("./", self.location.href);
const INDEX_URL = new URL("./index.html", BASE_URL).href;
const ROOT_URL = BASE_URL.href;
const APP_SHELL = [
  "./",
  "./index.html",
  "./assets/styles.css",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./js/app.js",
  "./js/program.js",
  "./js/storage.js",
  "./js/workouts.js",
  "./js/history.js",
  "./js/backup.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => (
      cache.addAll(APP_SHELL.map((path) => new URL(path, BASE_URL)))
    ))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "APPLY_UPDATE") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, copy))
            );
          }
          return response;
        })
        .catch(async () => (
          await caches.match(INDEX_URL, { cacheName: CACHE_NAME })
          || await caches.match(ROOT_URL, { cacheName: CACHE_NAME })
          || Response.error()
        ))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refreshed = fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached || Response.error());

      return cached || refreshed;
    })
  );
});
