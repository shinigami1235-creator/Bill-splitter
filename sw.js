/* Bump CACHE_VERSION on every deploy. Browsers keep serving the old build
   until this string changes. The photo reader under vendor/tesseract is
   cached on the first scan rather than at install, since it runs to about 7MB. */
const CACHE_VERSION = 'v1';
const CACHE = `bill-splitter-${CACHE_VERSION}`;
const FILES = [
  './',
  './index.html',
  './app.js',
  './split.js',
  './ocr.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('bill-splitter-') && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
