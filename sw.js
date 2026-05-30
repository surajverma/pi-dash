const CACHE_NAME = 'pi-dashboard-cache-v0.6.0';
const urlsToCache = [
  '{{CACHE_URL}}',
  '{{CACHE_URL}}css/style.css',
  '{{CACHE_URL}}js/app.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      }
    )
  );
});
