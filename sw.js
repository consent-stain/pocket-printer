const CACHE_NAME = 'printer-v4';
const ASSETS = [
  '/pocket-printer/',
  '/pocket-printer/index.html',
  '/pocket-printer/style.css',
  '/pocket-printer/app.js',
  '/pocket-printer/manifest.json',
  '/pocket-printer/icon-192.png',
  '/pocket-printer/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then((res) => res || fetch(e.request))
    );
  }
});
