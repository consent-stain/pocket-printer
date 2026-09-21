const CACHE_NAME = 'pocket-printer-v17';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
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
  // Web Share Target からのPOST受付
  if (e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image');
        const text = formData.get('text');
        const url = formData.get('url');

        const cache = await caches.open('shared-image');

        if (file && file.size > 0) {
          // 画像ファイルが共有された場合
          await cache.put('incoming-image', new Response(file));
        } else if (url || text) {
          // URLまたはテキスト（Google画像検索など）が共有された場合
          const targetUrl = url || text;
          await cache.put('incoming-url', new Response(targetUrl));
        }
      } catch (err) {
        console.error('POST共有受付エラー:', err);
      }
      return Response.redirect('index.html?from_share=1', 303);
    })());
    return;
  }

  // GETリクエスト（キャッシュ優先）
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then((res) => res || fetch(e.request))
    );
  }
});
