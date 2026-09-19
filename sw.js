const CACHE_NAME = 'pocket-printer-core-v2';
const PRECACHE_ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// 1. インストール時にアプリの核となる全ファイルをプリキャッシュ (Android WebAPK 審査の必須条件)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 2. アクティベーション時に古いキャッシュを一掃
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== 'shared-image').map((k) => caches.delete(k))
      );
    }).then(() => clients.claim())
  );
});

// 3. 通信ハンドリング
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Web Share Target からの画像共有受信 (POST)
  if (e.request.method === 'POST' && url.searchParams.get('from_share_post') === '1') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image');
        if (file) {
          const cache = await caches.open('shared-image');
          await cache.put('incoming-image', new Response(file));
        }
      } catch (err) {
        console.warn('共有ファイル解析エラー:', err);
      }
      return Response.redirect('./index.html?from_share=1', 303);
    })());
    return;
  }

  // 通常のGETアクセス: キャッシュ優先 & ネットワークフォールバック
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          // バックグラウンドで更新
          fetch(e.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((c) => c.put(e.request, networkResponse));
            }
          }).catch(() => {});
          return cachedResponse;
        }
        return fetch(e.request);
      })
    );
  }
});
