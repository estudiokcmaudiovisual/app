// sw.js
// Versione o cache ao alterar assets/estratégia:
const CACHE = 'cracha-presenca-v3';
const USER_CACHE = 'cracha-user-v1';

const ASSETS = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png',
  '/app.js', // mantenha apenas se existir no servidor
  '/vendor/html5-qrcode.min.js',
  '/vendor/qrcode.min.js',
  '/vendor/html2canvas.min.js',
  '/vendor/jspdf.umd.min.js',
  '/vendor/JsBarcode.all.min.js',
  'https://actions.google.com/sounds/v1/alarms/beep_short.ogg'
];

// permite que a página peça para ativar imediatamente uma nova versão do SW
self.addEventListener('message', (e) => {
  if (e?.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE);
      // addAll falha tudo se 1 item falhar; melhor tentar individualmente
      await Promise.allSettled(ASSETS.map(u => c.add(u)));
    } catch {}
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  const WHITELIST = [CACHE, USER_CACHE];
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (WHITELIST.includes(k) ? Promise.resolve() : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// Network-first para navegação (HTML); cache-first para estáticos.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Recursos do perfil offline (USER_CACHE)
  try {
    const url = new URL(req.url);
    if (url.pathname === '/offline/profile.json' || url.pathname === '/offline/profile-photo.jpg') {
      e.respondWith((async () => {
        const c = await caches.open(USER_CACHE);
        const hit = await c.match(url.pathname);
        return hit || fetch(req);
      })());
      return;
    }
  } catch {}

  const accepts = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || accepts.includes('text/html');

  if (isHTML) {
    e.respondWith((async () => {
      try {
        // rede primeiro
        const res = await fetch(req);
        // cacheia pela própria URL do request (inclui query)
        caches.open(CACHE).then(c => c.put(req, res.clone())).catch(()=>{});
        return res;
      } catch {
        // offline: tenta o request exato; depois '/', depois '/index.html'
        return (
          (await caches.match(req)) ||
          (await caches.match('/')) ||
          (await caches.match('/index.html')) ||
          new Response('<!doctype html><title>Offline</title><h1>Offline</h1>', {
            headers: { 'Content-Type': 'text/html' }
          })
        );
      }
    })());
    return;
  }

  // Estáticos e demais GETs: cache-first
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      caches.open(CACHE).then(c => c.put(req, res.clone())).catch(()=>{});
      return res;
    } catch {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
  })());
});
