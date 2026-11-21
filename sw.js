// Lucky Race Predictor service worker — makes the app installable
// (Add to Home screen / Install app) and caches the app shell offline.
// Pages (navigation) are network-first so new deploys show immediately;
// same-origin static assets are cache-first. Supabase / CDN traffic is
// never cached here.
const CACHE = 'lrp-v8'; // bump on every deploy that changes cached assets, so phones drop the old app.js
const ASSETS = [
  '.',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/config.js',
  'js/pwa.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Supabase / CDN: network only

  if (event.request.mode === 'navigate') {
    // Network first for pages, so a new deploy is never hidden behind the cache.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
    )
  );
});
