self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Web Share Target から画像受信時のキャッシュ & リダイレクト
  if (url.pathname.endsWith('/share-target') && e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const file = formData.get('image');
        if (file) {
          const cache = await caches.open('shared-image');
          await cache.put('incoming-image', new Response(file));
        }
      } catch (err) {
        console.error('共有画像データの解析失敗:', err);
      }
      return Response.redirect('./index.html?from_share=1', 303);
    })());
  }
});
