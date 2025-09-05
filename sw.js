// sw.js
const CACHE = 'cracha-presenca'; // ⬅️ mude o número sempre que quiser forçar update
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './app.js', // ⬅️ garanta que o app.js está aqui!
  './vendor/html5-qrcode.min.js',
  './vendor/qrcode.min.js',
  './vendor/html2canvas.min.js',
  './vendor/jspdf.umd.min.js',
  './vendor/JsBarcode.all.min.js',
  'https://actions.google.com/sounds/v1/alarms/beep_short.ogg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : null)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(()=>{});
        return res;
      }).catch(() => cached || new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
});
