/* sw.js — Service Worker do Crachá Digital */
const SW_VERSION = '2025.09.09-1';

/* Nomes de caches */
const PRECACHE = `precache-${SW_VERSION}`;
const HTML_CACHE = `html-${SW_VERSION}`;
const RUNTIME_STATIC = `static-${SW_VERSION}`;
const IMG_CACHE = `img-${SW_VERSION}`;
const FONT_CACHE = `font-${SW_VERSION}`;
const MEDIA_CACHE = `media-${SW_VERSION}`;

/* App Shell (ajuste caminhos conforme sua hospedagem) */
const APP_SHELL = [
  '/',                    // raiz
  '/index.html',          // HTML
  '/app.js',              // app consolidado
  '/sw.js',
  '/manifest.webmanifest',

  // Vendors (offline)
  '/vendor/html5-qrcode.min.js',
  '/vendor/qrcode.min.js',
  '/vendor/html2canvas.min.js',
  '/vendor/jspdf.umd.min.js',
  '/vendor/JsBarcode.all.min.js',

  // Ícones / imagens locais (se existirem)
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/logo-evento.png',
];

/* Util: network first com fallback e timeout (para navegação) */
async function networkFirstWithFallback(event, fallbackUrl = '/index.html', timeoutMs = 4000) {
  const cache = await caches.open(HTML_CACHE);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const net = await fetch(event.request, { signal: controller.signal });
    clearTimeout(t);
    if (net && net.ok) {
      // cacheia a página para visitas futuras
      cache.put(event.request, net.clone()).catch(() => {});
      return net;
    }
    // se veio algo não-ok, tenta cache
    const cached = await cache.match(event.request);
    return cached || await caches.match(fallbackUrl) || Response.error();
  } catch {
    clearTimeout(t);
    const cached = await cache.match(event.request);
    return cached || await caches.match(fallbackUrl) || Response.error();
  }
}

/* Estratégias simples */
async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const fetchPromise = fetch(event.request)
    .then(res => {
      if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return cached || fetchPromise || Response.error();
}

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  try {
    const res = await fetch(event.request);
    if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
    return res;
  } catch {
    return Response.error();
  }
}

/* INSTALL */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    try {
      await cache.addAll(APP_SHELL);
    } catch (e) {
      // Alguns arquivos podem não existir em todos ambientes; seguimos mesmo assim.
    }
    // Ativa imediatamente quando o app solicitar (postMessage 'SKIP_WAITING')
  })());
});

/* ACTIVATE */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Limpa caches antigos
    const keep = new Set([PRECACHE, HTML_CACHE, RUNTIME_STATIC, IMG_CACHE, FONT_CACHE, MEDIA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map(n => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

/* Mensagens do app */
self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data) return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* FETCH */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Deixe POST/PUT/etc irem direto (app já gerencia fila offline em IndexedDB)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Navegação (páginas)
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithFallback(event, '/index.html', 5000));
    return;
  }

  // Fonts (Google Fonts)
  if (url.origin.includes('fonts.googleapis.com') || url.origin.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(event, FONT_CACHE));
    return;
  }

  // Áudio remoto (beep do Google) ou outros media
  if (request.destination === 'audio' || request.destination === 'video') {
    event.respondWith(staleWhileRevalidate(event, MEDIA_CACHE));
    return;
  }

  // Imagens (logos, fotos, etc.)
  if (request.destination === 'image') {
    // mesma origem: cache-first; cross-origin: stale-while-revalidate
    if (sameOrigin) {
      event.respondWith(cacheFirst(event, IMG_CACHE));
    } else {
      event.respondWith(staleWhileRevalidate(event, IMG_CACHE));
    }
    return;
  }

  // Scripts/Workers/Styles e estáticos em geral
  if (['script', 'style', 'worker'].includes(request.destination) || sameOrigin) {
    event.respondWith(staleWhileRevalidate(event, RUNTIME_STATIC));
    return;
  }

  // Fallback final
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
