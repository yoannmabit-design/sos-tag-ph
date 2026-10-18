// Version du cache : à changer (sos-tag-v2, v3...) à chaque mise à jour des pages.
const CACHE = "sos-tag-v2";
const SHELL = ["/app.html", "/s.html", "/admin.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only our own pages are cached. Firebase calls (scan, profiles, SMS) always go to the network,
  // so no personal or medical data is stored on the phone.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() =>
        caches.match(e.request).then((m) =>
          m || (e.request.mode === "navigate" ? caches.match("/s.html") : undefined)
        )
      )
  );
});
