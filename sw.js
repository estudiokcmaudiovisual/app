/* sw.js — Service Worker do Crachá Digital */
const SW_VERSION = '2025.09.09-2';

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

  // Ícones / imagens locais (na RAIZ, conforme seus arquivos existentes)
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',

  // Outras imagens locais usadas na UI (se existir)
  '/logo-evento.png',
];

/* ========= FLUSH DA FILA (IndexedDB) — BACKGROUND ========= */

/** IMPORTANTE: mantenha em sincronia com o ENDPOINT do app.js */
const ENDPOINT = "https://script.google.com/macros/s/AKfycbwHk6o909wUncUcY0g0nRgJSpiZ-ZI7MtZjxMRCTrVU2yh9zm_M9uULA6SBYnTcuL0mEw/exec";

/** Config do IDB igual ao app */
const DB_NAME = 'cracha-db';
const STORE = 'presenceQueue';
const DB_VERSION = 4; // v4: índice clientKey

let swFlushing = false; // trava local do SW

function withDB(cb){
  return new Promise((resolve,reject)=>{
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = (e)=>{
      const db = open.result;
      let store;
      if(!db.objectStoreNames.contains(STORE)){
        store = db.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
      }else{
        store = e.target.transaction.objectStore(STORE);
      }
      try{
        if (!store.indexNames.contains('clientKey')) {
          store.createIndex('clientKey', 'payload.clientKey', { unique:true });
        }
      }catch(_){}
    };
    open.onsuccess = ()=> cb(open.result).then(resolve,reject);
    open.onerror  = ()=> reject(open.error);
  });
}

function allQueue({ onlyNotInflight=true, limit=Infinity } = {}){
  return withDB(db=>new Promise((res,rej)=>{
    const out=[]; const tx=db.transaction(STORE,'readonly');
    const req=tx.objectStore(STORE).openCursor();
    req.onsuccess=()=>{
      const c=req.result;
      if(c){
        const val = c.value || {};
        const inflight = !!val.inflight;
        if ((!onlyNotInflight || !inflight) && out.length < limit){
          out.push({ id:c.key, ...val });
        }
        c.continue();
      }else{
        res(out);
      }
    };
    req.onerror =()=>rej(req.error);
  }));
}

function updateInflight(id, inflight){
  return withDB(db=>new Promise((res,rej)=>{
    const tx=db.transaction(STORE,'readwrite');
    const store=tx.objectStore(STORE);
    const get=store.get(id);
    get.onsuccess=()=>{
      const rec = get.result;
      if (!rec){ res(); return; }
      rec.inflight = !!inflight;
      rec.inflightAt = inflight ? Date.now() : 0;
      const put = store.put(rec);
      put.onsuccess=()=>res();
      put.onerror =()=>rej(put.error);
    };
    get.onerror =()=>rej(get.error);
  }));
}

function clearStaleInflight(maxAgeMs = 3*60*1000){
  const now = Date.now();
  return withDB(db=>new Promise((res,rej)=>{
    const tx=db.transaction(STORE,'readwrite');
    const st=tx.objectStore(STORE);
    const req=st.openCursor();
    req.onsuccess=()=>{
      const c=req.result;
      if(c){
        const v = c.value || {};
        if (v.inflight && (!v.inflightAt || (now - v.inflightAt) > maxAgeMs)){
          v.inflight = false; v.inflightAt = 0;
          c.update(v);
        }
        c.continue();
      }else res();
    };
    req.onerror=()=>rej(req.error);
  }));
}

function removeId(id){
  return withDB(db=>new Promise((res,rej)=>{
    const tx=db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  }));
}

async function postForm(url, data, { timeoutMs=15000 } = {}){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const fd=new URLSearchParams();
    Object.keys(data||{}).forEach(k => fd.append(k, data[k]));
    const r=await fetch(url,{ method:'POST', body:fd, redirect:'follow', signal:ctrl.signal });
    if(!r.ok) throw new Error('http-'+r.status);
    return await r.text().catch(()=> '');
  } finally { clearTimeout(t); }
}

async function flushPresenceQueueSW(){
  if (swFlushing) return;
  swFlushing = true;
  try{
    await clearStaleInflight();

    // pega itens não-inflight (por segurança processa em lotes)
    const batch = await allQueue({ onlyNotInflight:true, limit:20 });
    if (!batch.length) return;

    for (const it of batch){
      const { id, payload } = it;
      try{
        await updateInflight(id, true);
      }catch{ /* segue tentando enviar mesmo assim */ }

      try{
        await postForm(ENDPOINT, payload);
        await removeId(id);
      }catch(e){
        // falha de rede: libera para tentar depois
        try{ await updateInflight(id, false); }catch{}
      }
    }

    // Recursive-ish: se ainda restar coisa, agenda um novo ciclo rápido
    const rest = await allQueue({ onlyNotInflight:true, limit:1 });
    if (rest.length){
      // tenta continuar em background sem estourar o evento
      setTimeout(()=>{ flushPresenceQueueSW().catch(()=>{}); }, 200);
    }
  } finally {
    swFlushing = false;
  }
}

/* ========= Estruturas de cache/estratégias já existentes ========= */

/* Util: network first com fallback e timeout (para navegação) */
async function networkFirstWithFallback(event, fallbackUrl = '/index.html', timeoutMs = 5000) {
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
  } else if (data.type === 'REQUEST_FLUSH') {
    // permite que a página peça flush “by name”
    event.waitUntil(flushPresenceQueueSW());
  }
});

/* BACKGROUND SYNC */
self.addEventListener('sync', (event) => {
  if (event.tag === 'presence-sync') {
    event.waitUntil(flushPresenceQueueSW());
  }
});

/* PERIODIC BACKGROUND SYNC (quando suportado) */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'presence-periodic') {
    event.waitUntil(flushPresenceQueueSW());
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
