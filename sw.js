// sw.js
// Versione o cache ao alterar assets/estratégia:
const CACHE = 'cracha-presenca-v3';

const ASSETS = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png',
  '/app.js',                 // se o seu app principal é app.js, mantenha
  '/app.a2hs.js',            // opcional (botão instalar)
  // vendors (se existirem nesses caminhos; ajuste se precisar)
  '/vendor/html5-qrcode.min.js',
  '/vendor/qrcode.min.js',
  '/vendor/html2canvas.min.js',
  '/vendor/jspdf.umd.min.js',
  '/vendor/JsBarcode.all.min.js',
  // exemplo de asset remoto simples (ok ignorar se preferir não cachear remotos):
  'https://actions.google.com/sounds/v1/alarms/beep_short.ogg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== CACHE ? caches.delete(k) : Promise.resolve())))
    )
  );
  self.clients.claim();
});

// Network-first para navegação (HTML); cache-first para estáticos.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const accepts = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accepts.includes('text/html');

  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put('/', clone)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cached = (await caches.match(req)) || (await caches.match('/index.html'));
          return (
            cached ||
            new Response('<!doctype html><title>Offline</title><h1>Offline</h1>', {
              headers: { 'Content-Type': 'text/html' }
            })
          );
        })
    );
    return;
  }

  // Estáticos: cache-first com atualização em background
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
          return res;
        })
        .catch(() => cached || new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
});
