const CACHE_NAME = 'pocket-printer-v13';
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
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(keys.map((k) => (k !== CACHE_NAME && k !== 'shared-image' ? caches.delete(k) : null)))
      )
    ])
  );
});

self.addEventListener('fetch', (e) => {
  // Web Share Target からの画像POST受付
  if (e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image');
        if (file) {
          const cache = await caches.open('shared-image');
          await cache.put('incoming-image', new Response(file));
        }
      } catch (err) {
        console.error('POST共有エラー:', err);
      }
      return Response.redirect('/pocket-printer/?from_share=1', 303);
    })());
    return;
  }

  // GETリクエスト（オフライン対応）
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then((res) => res || fetch(e.request))
    );
  }
});
