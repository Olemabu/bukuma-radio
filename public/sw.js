// Bukuma Radio Service Worker
// Cache only static UI assets. Never cache API calls or the audio stream.
const CACHE_NAME = 'bukuma-v3';
const STATIC_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/style.css',
  '/app/manifest.json',
  '/images/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // NEVER cache or intercept: audio streams, API endpoints, WebSocket upgrades
  if (
    url.includes('/api/') ||
    url.includes('/stream') ||
    url.includes('/ws') ||
    event.request.method !== 'GET'
  ) {
    // Pass through directly to network — no caching whatsoever
    return;
  }

  // For static assets: cache-first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
