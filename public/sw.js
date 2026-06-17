self.__THEO_SW_VERSION__ = 'theo-shell-v2';
const SHELL_CACHE = self.__THEO_SW_VERSION__;
const SHELL_FALLBACK_URLS = ['/chat/', '/chat/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FALLBACK_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('theo-shell-') && key !== SHELL_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isWebSocket = url.protocol === 'ws:' || url.protocol === 'wss:' || event.request.headers.get('upgrade') === 'websocket';
  if (isWebSocket || event.request.method !== 'GET' || !url.pathname.startsWith('/chat/')) return;

  const isNavigation = event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(new Request(event.request, { cache: 'no-store' }))
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/chat/', copy));
          return response;
        })
        .catch(() => caches.match('/chat/'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {};
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Théo', {
    body: data.body || '',
    icon: '/chat/icon-192.png',
    data: { url: data.url || '/chat/' },
    tag: 'msg-' + Date.now(),
    renotify: true
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
