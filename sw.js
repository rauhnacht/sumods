/* SUMods service worker: the app shell stays cached so the timetable opens offline,
   while course data is refreshed from the network whenever it is reachable. */
const VERSION = 'sumods-v2';   // bumped so every visitor's old cache-first SW gets replaced
const SHELL = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest',
               './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Network-first, cache as an offline fallback only — for the app shell (app.js, index.html,
  // app.css) just as much as for course data. Cache-first for the shell was the wrong call: it
  // meant a freshly deployed app.js could sit unseen for a whole extra visit, since the stale
  // cached copy was served immediately and the network fetch only updated the cache for next
  // time. Network-first still lets the app open offline (via .catch below) without ever being
  // a version behind while online, which is what actually matters for a site under active
  // development.
  event.respondWith(
    fetch(request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(request, copy));
      }
      return res;
    }).catch(() => caches.match(request)),
  );
});
