const CACHE_PREFIX = "workout-program-shell-";
const CACHE_VERSION = "v6";
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
  "./js/auth.js",
  "./js/cloud-config.js",
  "./js/cloud-sync.js",
  "./js/program.js",
  "./js/storage.js",
  "./js/workouts.js",
  "./js/history.js",
  "./js/backup.js",
  "./js/migrations.js",
  "./js/catalog/index.js",
  "./js/catalog/shared.js",
  "./js/catalog/legacy-spine.js",
  "./js/catalog/spine-safe.js",
  "./js/catalog/athlete.js",
  "./js/catalog/glute-shape.js",
  "./js/catalog/upper-lower.js",
  "./js/catalog/minimalist.js"
];
const APP_SHELL_BY_PATH = new Map(APP_SHELL.map((path) => {
  const url = new URL(path, BASE_URL);
  return [url.pathname, url.href];
}));
const missingShellResponse = () => new Response("Cached application shell is incomplete", {
  status: 503,
  statusText: "Cached shell incomplete",
  headers: { "content-type": "text/plain; charset=utf-8" },
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await caches.delete(CACHE_NAME);
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(APP_SHELL.map((path) => new URL(path, BASE_URL)));
      } catch (error) {
        await caches.delete(CACHE_NAME);
        throw error;
      }
    })()
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
  if (event.data?.type === "GET_BUILD_VERSION") {
    event.ports?.[0]?.postMessage({
      type: "BUILD_VERSION",
      build: CACHE_VERSION,
      shellPolicy: "cache-only",
      baseUrl: BASE_URL.href,
    });
    return;
  }
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
      caches.open(CACHE_NAME).then(async (cache) => (
        await cache.match(INDEX_URL)
        || await cache.match(ROOT_URL)
        || await fetch(event.request)
      ))
    );
    return;
  }

  const shellUrl = APP_SHELL_BY_PATH.get(requestUrl.pathname);
  if (shellUrl) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => (
        await cache.match(shellUrl)
        || missingShellResponse()
      ))
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => (
      await cache.match(event.request)
      || await fetch(event.request)
    ))
  );
});
