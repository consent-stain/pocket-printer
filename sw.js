const CACHE_NAME = 'pocket-printer-v20';
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

// POST共有リクエストの完全インターセプト（GitHub Pagesへの通信を遮断して405を防止）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image');
        const text = formData.get('text');
        const sharedUrl = formData.get('url');

        const cache = await caches.open('shared-image');

        if (file && file.size > 0) {
          // 画像ファイルが渡された場合
          await cache.put('incoming-image', new Response(file));
        } else if (sharedUrl || text) {
          // URLまたはテキスト（Google画像検索など）が渡された場合
          const target = sharedUrl || text;
          await cache.put('incoming-url', new Response(target));
        }
      } catch (err) {
        console.error('共有インターセプトエラー:', err);
      }
      // 303リダイレクトでGET画面へ安全に戻す
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
