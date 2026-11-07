/* Offline-Cache: App-Dateien werden beim ersten Besuch gespeichert. */
const CACHE = "rezeptbox-v3";
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "data/recipes.json", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).hostname === "api.anthropic.com") return;
  // Netzwerk zuerst (für Updates), bei Offline aus dem Cache
  e.respondWith(fetch(req).then(res => {
    if (res.ok && (new URL(req.url).origin === location.origin || req.url.includes("fonts.g"))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
});
