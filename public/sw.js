self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('theo-shell-v1').then((cache) => cache.addAll(['/chat/', '/chat/manifest.webmanifest']))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/chat/') && event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match('/chat/')))
    );
  }
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
