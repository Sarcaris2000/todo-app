// Service worker: receives the morning digest and opens the app when tapped.

// Bump this on any deploy that changes the API contract. A new cache name
// forces the install/activate cycle, which triggers `controllerchange` in
// app.js and reloads any page still running the previous build.
const CACHE = 'todo-shell-v26';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/parse.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for the shell so a redeploy is picked up immediately, with the
// cache as an offline fallback. API calls always go to the network.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let data = { title: "Today's focus", body: '' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: "Today's focus", body: event.data.text() };
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Today's focus", {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag || 'daily-digest',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
