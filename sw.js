/**
 * FogWalker Service Worker
 * オフライン動作 & PWAキャッシュ
 * - 画面(index.html)はネットワーク優先：更新がすぐ届く
 * - それ以外の資産はキャッシュ優先：オフラインでも動く
 */

const CACHE_NAME = 'fogwalker-v2-2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('Some assets could not be pre-cached:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // 外部CDNやAPIリクエストはそのままネットワークへ
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // 画面・スクリプト・スタイルはネットワーク優先（更新を即反映し、失敗時のみキャッシュ）
  const networkFirst = event.request.mode === 'navigate' ||
    ['document', 'script', 'style', 'worker'].includes(event.request.destination) ||
    event.request.url.endsWith('manifest.json');

  if (networkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // それ以外の資産はキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      });
    }).catch(() => {
      if (event.request.destination === 'document') {
        return caches.match('./index.html');
      }
    })
  );
});
