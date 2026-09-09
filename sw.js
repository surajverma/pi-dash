const CACHE_NAME = 'pi-dashboard-cache-v5-query-row-height';
const APP_SHELL = [
  '{{CACHE_URL}}',
  '{{CACHE_URL}}css/style.css',
  '{{CACHE_URL}}css/dashboard.css',
  '{{CACHE_URL}}js/dashboard-core.js',
  '{{CACHE_URL}}js/app.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('pi-dashboard-cache-') && name !== CACHE_NAME).map(name => caches.delete(name))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const base = new URL('{{CACHE_URL}}', self.location.origin).pathname;
  if (!url.pathname.startsWith(base)) return;
  const relative = url.pathname.slice(base.length);
  // API responses contain live DNS information and must never enter CacheStorage.
  if (['init', 'data', 'queries', 'health'].includes(relative)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
        }
        return response;
      }).catch(() => caches.match(event.request).then(response => response || caches.match('{{CACHE_URL}}')))
    );
    return;
  }
  // Network-first avoids serving an old JS/CSS bundle after a container upgrade.
  if (!APP_SHELL.some(asset => new URL(asset, self.location.origin).pathname === url.pathname)) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
