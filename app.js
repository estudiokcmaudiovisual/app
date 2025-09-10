/* app.js — toda a lógica do PWA consolidada (com dedupe offline e flush com lock) */
(() => {
  'use strict';

  /* ========= CONFIG ========= */
  const CONFIG = {
    ENDPOINT: "https://script.google.com/macros/s/AKfycbwHk6o909wUncUcY0g0nRgJSpiZ-ZI7MtZjxMRCTrVU2yh9zm_M9uULA6SBYnTcuL0mEw/exec",
    CARD_WIDTH: 638,
    CARD_HEIGHT: 1011,
    QR_SIZE: 170,
    // Base64/URLs opcionais (pode sobrescrever aqui)
    BG_BASE64: "imagem1",
    BG_BACK_BASE64: "imagem2",
    LOGO_MAIN_BASE64: "imagem3",
    LOGO_FOOTER1_BASE64: "imagem4",
    LOGO_FOOTER2_BASE64: "imagem5",
    USER_CACHE: 'cracha-user-v1',
    PROFILE_JSON_PATH: '/offline/profile.json',
    PROFILE_IMG_PATH:  '/offline/profile-photo.jpg'
  };
  window.ENDPOINT = CONFIG.ENDPOINT; // compat

  const supports3D = (typeof CSS!=='undefined' && CSS.supports && CSS.supports('transform-style','preserve-3d'));

  /* ========= STATE ========= */
  const currentData = { name:'', code:'', photoUrl:'' };
  let eventoValido = false;
  let qrInstance   = null;
  let submitBusy   = false;   // evita duplo submit na mesma tela

  /* ========= UTILS ========= */
  const px2mm = p => p * 0.264583;
  function sanitizeForBarcode(s){return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
  function getInitials(n){return n? n.trim().split(' ').filter(Boolean).map(p=>p[0].toUpperCase()).join(''):'';}
  function makeProtocol(code,name){
    const d=new Date(),p=n=>String(n).padStart(2,'0');
    const ts=`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
    const clean=sanitizeForBarcode(code), half=Math.floor(clean.length/2);
    return `${ts}${clean.slice(0,half)}${getInitials(name)}${clean.slice(half)}`;
  }
  function escHtml(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
  function splitNameTwoLines(name){
    const n=(name||'').trim(); if(!n) return 'Nome';
    const parts=n.split(/\s+/);
    if(parts.length<=2) return escHtml(n);
    const first=parts.slice(0,2).join(' '), rest=parts.slice(2).join(' ');
    return `${escHtml(first)}<br><span class="name-2">${escHtml(rest)}</span>`;
  }

  // UUID v4 (clientKey)
  function uuidv4(){
    if (typeof crypto!=='undefined' && crypto.randomUUID) return crypto.randomUUID();
    const a=new Uint8Array(16);
    if (typeof crypto!=='undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
    else for(let i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*256);
    a[6]=(a[6]&0x0f)|0x40; a[8]=(a[8]&0x3f)|0x80;
    const b=[...a].map((v,i)=>v.toString(16).padStart(2,'0')).join('');
    return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20)}`;
  }
  // Id do dispositivo (persistente) e nonce por registro (idempotência)
  function getClientId(){
    try{
      let id = localStorage.getItem('pwa:clientId');
      if (!id) { id = (self.crypto?.randomUUID?.() || ('c-'+Math.random().toString(36).slice(2)+Date.now())); localStorage.setItem('pwa:clientId', id); }
      return id;
    }catch{ return 'c-'+Date.now(); }
  }
  function genNonce(){ return (self.crypto?.randomUUID?.() || (Date.now().toString(36)+'-'+Math.random().toString(36).slice(2))); }

  const isDataUrl=s=>/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s||'');
  const isHttp=s=>/^(https?:)?\/\//.test(s||'');
  const isRel=s=>/^[./]/.test(s||'');
  const looksPureBase64=s=>!!s && /^[A-Za-z0-9+/=\s]+$/.test(s) && s.replace(/\s+/g,'').length>100;
  const toDataUrlIfNeeded=(src,mime='image/png')=>{
    if(!src) return null; if(isDataUrl(src)||isHttp(src)||isRel(src)) return src;
    if(looksPureBase64(src)) return `data:${mime};base64,${src.replace(/\s+/g,'')}`; return null;
  };
  function setImageSrcById(id,src){
    const el=document.getElementById(id); if(!el) return;
    const placeholder='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220"><rect width="100%" height="100%" fill="#222"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-family="Arial, sans-serif" font-size="28">LOGO</text></svg>');
    el.src=toDataUrlIfNeeded(src)||placeholder;
  }
  function setBgImageById(id,src){
    const el=document.getElementById(id); if(!el) return;
    const candidate=toDataUrlIfNeeded(src,'image/jpeg');
    if(candidate) el.style.backgroundImage=`url('${candidate}')`;
  }
  function fitPreviewToContainer(){
    const wrap=document.getElementById('previewWrap'); if(!wrap) return;
    const parentWidth=wrap.parentElement?wrap.parentElement.clientWidth:window.innerWidth;
    const parentHeight=window.innerHeight-24;
    const cw=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w'));
    const ch=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-h'));
    const scaleByW=(parentWidth-16)/cw;
    const scaleByH=(parentHeight-16)/ch;
    const scale=Math.max(.16,Math.min(1,Math.min(scaleByW,scaleByH)));
    document.documentElement.style.setProperty('--preview-scale', String(scale));
    wrap.style.width=`calc(var(--card-w)*var(--preview-scale))`;
    wrap.style.height=`calc(var(--card-h)*var(--preview-scale))`;
  }

  /* ========= RENDER ========= */
  function safeRenderQR(){
    if(!window.QRCode) return;
    const cont=document.getElementById('qr'); if(!cont) return;
    cont.innerHTML='';
    new QRCode(cont,{text:JSON.stringify({nome:currentData.name||'Nome',codigo:currentData.code||''}),width:CONFIG.QR_SIZE,height:CONFIG.QR_SIZE});
  }
  function safeRenderBarcode(){
    const protocol=makeProtocol(currentData.code||'', currentData.name||'Nome');
    const protocolEl=document.getElementById('protocolText'); if(protocolEl) protocolEl.textContent=protocol;
    if(window.JsBarcode){
      const svg=document.getElementById('barcode');
      if(svg){ while(svg.firstChild) svg.removeChild(svg.firstChild);
        JsBarcode(svg,protocol,{format:"CODE128",lineColor:"#FFFFFF",background:"transparent",width:2,height:15,displayValue:false,margin:0});
      }
    }
  }
  function renderAll(){ safeRenderQR(); safeRenderBarcode(); }

  function setBadgeData(name,code,photoUrl){
    currentData.name=name||''; currentData.code=code||''; currentData.photoUrl=photoUrl||'';
    const nameEl=document.getElementById('pName'); if(nameEl) nameEl.innerHTML=splitNameTwoLines(currentData.name);
    const codeEl=document.getElementById('pCode'); if(codeEl) codeEl.textContent=currentData.code||'memberId';
    const img=document.getElementById('pPhoto'); if(img){ img.crossOrigin='anonymous';
      img.src=currentData.photoUrl||'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzAwIiBoZWlnaHQ9IjMwMCI+PC9zdmc+';}
    renderAll();
  }
  window.setBadgeData = setBadgeData;

  async function prefillFromCacheThenURL(){
    try{ if(typeof window.loadUserProfile==='function'){
      const prof=await window.loadUserProfile();
      if(prof && prof.fullName && prof.memberId){ setBadgeData(prof.fullName,prof.memberId,prof.photoUrl); }
    }}catch{}
    try{
      const manual = localStorage.getItem('pwa:manualName');
      if (manual && !currentData.name) setBadgeData(manual, currentData.code, currentData.photoUrl);
    }catch{}
    const p=new URLSearchParams(location.search);
    const name=p.get('name')||p.get('nome')||'';
    const code=p.get('code')||p.get('memberid')||p.get('memberId')||p.get('matricula')||'';
    const photo=p.get('photo')||p.get('foto')||'';
    if(name||code||photo){
      setBadgeData(name,code,photo);
      try{ await cacheUserProfileSmart({ fullName: name, memberId: code, photo }); }catch{}
    }

    // Fallback extra: carrega do OPFS (profile.json) se ainda não houver nome/código
    if ((!currentData.name || !currentData.code) && typeof loadProfileShadowFile === 'function'){
      try{
        const shadow = await loadProfileShadowFile();
        if (shadow?.fullName && shadow?.memberId){
          setBadgeData(shadow.fullName, shadow.memberId, shadow.photoUrl);
        }
      }catch{}
    }
  }

  /* ========= QR / CAMERA ========= */
  function lockReaderVideoSize(){
    const v = document.querySelector('#reader video');
    if (v){
      v.style.width = '100%';
      v.style.height = 'var(--qr-height)';
      v.style.objectFit = 'cover';
      v.style.borderRadius = '16px';
      v.style.display = 'block';
    }
  }
  async function startQR(){
    try{
      if(!window.Html5Qrcode){ console.warn('html5-qrcode ainda não carregado.'); return; }
      if(qrInstance) return;
      qrInstance=new Html5Qrcode("reader");
      await qrInstance.start({ facingMode:"environment" }, { fps:10, qrbox:250 }, onScanSuccess);
      lockReaderVideoSize(); setTimeout(lockReaderVideoSize, 300); setTimeout(lockReaderVideoSize, 900);
    }catch(e){ console.warn("Falha ao iniciar câmera:", e); }
  }
  async function stopQR(){
    try{ if(qrInstance){ await qrInstance.stop(); await qrInstance.clear(); qrInstance=null; } }catch(e){}
  }
  function onScanSuccess(decodedText){
    const eventoInput=document.getElementById('evento');
    const bip=document.getElementById('bip');
    try{
      const data=JSON.parse(decodedText);
      if(data && data.nome && data.codigo){
        if(eventoInput) eventoInput.value=`${data.nome} - ${data.codigo}`; eventoValido=true; try{bip && bip.play();}catch{}
        mostrarMensagem("Evento lido com sucesso!", false);
      }else{ mostrarMensagem('QR inválido. Esperado {"nome":"...","codigo":"..."}', true); }
    }catch(e){ mostrarMensagem("Leitura inválida do QR.", true); }
  }

  /* ========= UI helpers ========= */
  function flipKeepingViewport(fn){
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    fn();
    requestAnimationFrame(()=>{
      if (document.activeElement && document.activeElement.blur) {
        try { document.activeElement.blur(); } catch {}
      }
      window.scrollTo(0, y);
    });
  }
  function mostrarMensagem(t,err){
    const msg=document.getElementById('msg'); if(!msg) return;
    msg.textContent=t; msg.classList.toggle('error',!!err);
  }
  function setStatusOfflineUI(){
    const statusBar=document.getElementById('statusBar');
    if (statusBar) statusBar.textContent = navigator.onLine ? "" : "Sem conexão — os registros serão enviados automaticamente quando a internet voltar.";
  }

  /* ========= TOAST / PROC ========= */
  (function(){
    function showToast({title, text, kind='info', ms=3500}){
      const wrap=document.getElementById('pwaToasts'); if(!wrap) return;
      const el=document.createElement('div'); el.className='pwa-toast '+kind;
      el.innerHTML=(title?'<div class="title">'+title+'</div>':'')+(text||'');
      wrap.appendChild(el);
      setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .2s'; }, Math.max(0,ms-180));
      setTimeout(()=>{ el.remove(); }, ms);
    }
    window.PWA_TOAST={ show:showToast };
  })();
  (function(){
    const barId = 'procBar';
    function showProc(text, kind='pending'){
      const bar = document.getElementById(barId); if(!bar) return;
      bar.className = 'proc-bar show proc-' + (kind==='pending'?'pending':kind);
      bar.textContent = text || '';
    }
    function hideProc(delayMs=1200){
      const bar = document.getElementById(barId); if(!bar) return;
      setTimeout(()=>{ bar.className = 'proc-bar'; bar.textContent=''; }, Math.max(0, delayMs));
    }
    window.PROC = {
      pending: (t='Aguarde: processando registro digital…') => showProc(t,'pending'),
      success: (t='Registro realizado com sucesso!') => { showProc(t,'success'); hideProc(); },
      queued:  (t='Sem internet: registro será enviado quando a conexão voltar.') => { showProc(t,'queued'); hideProc(2000); },
      error:   (t='Falha ao processar. Tente novamente.') => { showProc(t,'error'); hideProc(2000); },
      show: showProc, hide: hideProc
    };
  })();

  /* ========= PROFILE CACHE API ========= */
  // (A) Cache Storage (já existente)
  async function cacheUserProfile({ fullName, memberId, photoUrl }) {
    if (!fullName || !memberId) { console.warn('[PWA] cacheUserProfile: dados faltando'); return; }
    const profile = { fullName, memberId, photoLocal: CONFIG.PROFILE_IMG_PATH, photoUrl: photoUrl || '', ts: Date.now() };
    const profileRes = new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } });

    let photoRes = null;
    if (photoUrl) {
      try{
        const resp = await fetch(photoUrl, { mode:'cors' });
        if (resp.ok) {
          const photoBlob = await resp.blob();
          photoRes = new Response(photoBlob, { headers: { 'Content-Type': photoBlob.type || 'image/jpeg' } });
        }
      }catch(e){ /* segue sem foto */ }
    }

    const cache = await caches.open(CONFIG.USER_CACHE);
    await cache.put(CONFIG.PROFILE_JSON_PATH, profileRes);
    if (photoRes) await cache.put(CONFIG.PROFILE_IMG_PATH,  photoRes);
    try { localStorage.setItem('pwa:profileCached', '1'); } catch {}

    // (B) Fallback extra: grava sombra no OPFS
    try { await saveProfileShadowFile(profile); } catch {}

    console.log('[PWA] Perfil salvo para uso offline');
  }
  async function loadUserProfile() {
    try {
      const cache = await caches.open(CONFIG.USER_CACHE);
      const res = await cache.match(CONFIG.PROFILE_JSON_PATH);
      if (!res) return null;
      const profile = await res.json();
      return { ...profile, photoUrl: profile.photoUrl || profile.photoLocal || CONFIG.PROFILE_IMG_PATH };
    } catch { return null; }
  }
  function getLaunchParams(){
    const params = new URLSearchParams(location.search);
    if ([...params].length) return params;
    try {
      const raw = localStorage.getItem('pwa:lastCtx'); if (!raw) return params;
      const { search } = JSON.parse(raw) || {};
      return search ? new URLSearchParams(search) : params;
    } catch { return params; }
  }
  async function cacheUserProfileSmart({ fullName, memberId, photo }) {
    await cacheUserProfile({ fullName, memberId, photoUrl: photo });
  }
  window.cacheUserProfile = cacheUserProfile;
  window.loadUserProfile  = loadUserProfile;
  window.getLaunchParams  = getLaunchParams;
  window.cacheUserProfileSmart = cacheUserProfileSmart;

  // (C) OPFS: arquivo local "profile.json" (sem prompt) — Chromium-based
  async function saveProfileShadowFile(profile){
    try{
      if (!('storage' in navigator) || !navigator.storage.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('profile.json', { create:true });
      const w = await fh.createWritable();
      await w.write(new Blob([JSON.stringify(profile)], { type:'application/json' }));
      await w.close();
    }catch{}
  }
  async function loadProfileShadowFile(){
    try{
      if (!('storage' in navigator) || !navigator.storage.getDirectory) return null;
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('profile.json', { create:false });
      const file = await fh.getFile();
      const txt = await file.text();
      return JSON.parse(txt);
    }catch{ return null; }
  }
  window.saveProfileShadowFile = saveProfileShadowFile;
  window.loadProfileShadowFile = loadProfileShadowFile;

  /* ========= BACKGROUND/FOREGROUND FLUSH SUPPORT ========= */
  // Registra Background Sync (quando disponível) para “segundo plano”
  function requestBackgroundSync(tag='presence-sync'){
    if ('serviceWorker' in navigator && 'SyncManager' in window){
      navigator.serviceWorker.ready
        .then(reg => reg.sync.register(tag))
        .catch(()=>{});
    }
  }
  // (Opcional) Periodic Background Sync — nem todos navegadores suportam.
  async function requestPeriodicSync(){
    try{
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      if (!reg.periodicSync) return;
      const tags = await reg.periodicSync.getTags();
      if (!tags.includes('presence-periodic')){
        await reg.periodicSync.register('presence-periodic', { minInterval: 15 * 60 * 1000 });
      }
    }catch{}
  }

  // >>> NOVO: pedir flush ao Service Worker; retorna true se delegou
  // Pede flush ao SW; retorna true se há SW controlador
function requestSwFlush(){
  try{
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'REQUEST_FLUSH' });
      return true;
    }
  }catch{}
  return false;
}

  // Debounce para qualquer tentativa de flush
  let __flushDebTimer;
function flushDebounced(){
  clearTimeout(__flushDebTimer);
  __flushDebTimer = setTimeout(async () => {
    const delegated = requestSwFlush();
    if (delegated) {
      // Fallback: se em 1500 ms ainda houver pendências, faz flush local
      setTimeout(async () => {
        try{
          if (!navigator.onLine) return;
          const has = await (window.presenceQueueAPI?.hasPending?.() || Promise.resolve(false));
          if (has && window.flushPresenceQueue) await window.flushPresenceQueue();
        }catch{}
      }, 1500);
      return;
    }
    // Sem SW controlador → flush local
    if (window.flushPresenceQueue) window.flushPresenceQueue().catch(()=>{});
  }, 500);
}

  // Batimento: checa conectividade e pendências a cada 10s (prioriza SW)
  let __heartbeatTimer = null;
  function startFlushHeartbeat(){
    clearInterval(__heartbeatTimer);
    __heartbeatTimer = setInterval(() => {
      if (!navigator.onLine) return;
      flushDebounced();        // delega ao SW ou faz local se não houver SW
      requestBackgroundSync(); // redundância: pede sync no SW
    }, 10_000);
  }

  /* ========= SYNC BANNER ========= */
  (function(){
    const $ = (sel) => document.querySelector(sel);
    const banner = $('#syncBanner');
    const btnNow = $('#syncNowBtn');
    const btnClose = $('#syncCloseBtn');
    const msg = $('#syncBannerMsg');
    const title = $('#syncTitle');
    const manualWrap = $('#manualNameWrap');
    const manualInput = $('#manualName');
    const manualSave = $('#manualNameSave');

    function showBanner(kind, text, autoHideMs){
      banner.classList.remove('ok','warn','err','info');
      banner.classList.add(kind);
      if (text) msg.textContent = text;
      banner.classList.add('show');
      banner.style.display='block';
      if (autoHideMs && kind==='ok'){
        setTimeout(()=>{ hideBannerSmooth(); }, autoHideMs);
      }
    }
    function hideBannerSmooth(){
      banner.classList.remove('show');
      setTimeout(()=>{ banner.style.display='none'; }, 200);
    }
    function readCurrentFields(){
      const nome = (window.currentData && currentData.name) || ($('#nome')?.value) || ($('#pName')?.textContent) || '';
      const codigo = (window.currentData && currentData.code) || ($('#codigo')?.value) || ($('#pCode')?.textContent) || '';
      const cleanNome = (nome||'').trim().replace(/^Nome$/,'');
      const cleanCodigo = (codigo||'').trim().replace(/^memberId$/,'');
      return { nome: cleanNome, codigo: cleanCodigo };
    }
    function setBanner(kind, text){
      showBanner(kind, text, kind==='ok' ? 1600 : undefined);
      title.textContent = (kind==='ok'?'Sincronizado':kind==='warn'?'Aguardando sincronização':'Sincronização necessária');
      manualWrap.style.display = (kind==='err') ? 'flex' : 'none';
    }
    async function updateSyncStatus(){
      const { nome, codigo } = readCurrentFields();
      if (nome && codigo){ setBanner('ok', 'Seus dados foram carregados. Tudo certo!'); return; }
      if (nome || codigo){ setBanner('warn', 'Dados parciais encontrados. Aguarde a sincronização automática…'); return; }
      setBanner('err', 'Nenhum dado encontrado. Sincronize ou informe seu nome completo para começar.');
    }
    async function ensureProfileFromURL({ cleanQuery=true } = {}) {
      try {
        const params = (typeof window.getLaunchParams === 'function') ? window.getLaunchParams() : new URLSearchParams(location.search);
        const fullName = params.get('name') || params.get('fullname') || params.get('nome');
        const memberId = params.get('memberId') || params.get('id') || params.get('matricula');
        let photo = params.get('photo') || params.get('foto') || params.get('image');
        if (!fullName || !memberId) return false;
        if (typeof window.cacheUserProfileSmart === 'function') {
          await window.cacheUserProfileSmart({ fullName, memberId, photo });
        }
        if (cleanQuery && (location.search || '').length > 1 && history.replaceState) { history.replaceState(null, '', location.pathname); }
        return true;
      } catch (e) { console.warn('[PWA] ensureProfileFromURL falhou:', e); return false; }
    }

    manualSave?.addEventListener('click', async ()=>{
      const v = (manualInput?.value||'').trim();
      if (!v || v.length < 3){ msg.textContent = 'Digite um nome válido.'; return; }
      try{ localStorage.setItem('pwa:manualName', v); }catch{}
      const currentCode = (window.currentData && currentData.code) || '';
      setBadgeData(v, currentCode, (window.currentData && currentData.photoUrl) || '');
      const nomeInput = document.getElementById('nome'); if (nomeInput) nomeInput.value = v;
      try{ await cacheUserProfileSmart({ fullName: v, memberId: currentCode, photo: (window.currentData && currentData.photoUrl) || '' }); }catch{}
      updateSyncStatus();
    });
    btnNow && btnNow.addEventListener('click', async ()=>{
      await ensureProfileFromURL({ cleanQuery:false });
      await updateSyncStatus();
    });
    btnClose && btnClose.addEventListener('click', hideBannerSmooth);

    window.updateSyncStatus = updateSyncStatus;
    window.ensureProfileFromURL = ensureProfileFromURL;

    window.addEventListener('online', updateSyncStatus);
    window.addEventListener('offline', updateSyncStatus);
    window.addEventListener('load', async () => {
      if (navigator.onLine) { await ensureProfileFromURL({ cleanQuery:false }); await updateSyncStatus(); }
      else { await updateSyncStatus(); }
    });
  })();

  /* ========= FILA / ENVIO (IndexedDB, com dedupe e flush lock) ========= */
  (function(){
    const ENDPOINT = CONFIG.ENDPOINT;
    const DB_NAME = 'cracha-db'; const STORE = 'presenceQueue';
    const DB_VERSION = 4; // v4: índice clientKey

    // ---- Idempotência adicional (nonce enviado com sucesso) ----
    function loadSentSet(){ try{ return new Set(JSON.parse(localStorage.getItem('pwa:sentNonces')||'[]')); }catch{ return new Set(); } }
    function saveSentSet(set){
      try{
        const arr = [...set];
        if (arr.length > 600) arr.splice(0, arr.length - 600);
        localStorage.setItem('pwa:sentNonces', JSON.stringify(arr));
      }catch{}
    }
    let sentNonces = loadSentSet();

    // lock para evitar flush concorrente (local + entre abas)
    let flushing = false;
    let flushPromise = null;
    const inFlight = new Set();

    // Fallback de lock cross-tab via localStorage
    const LS_LOCK_KEY = 'pwa:presenceFlushLock_v1';
    function acquireLsLock(ttlMs = 10000){
      try{
        const now = Date.now();
        const raw = localStorage.getItem(LS_LOCK_KEY);
        if (raw){
          const { t } = JSON.parse(raw);
          if (now - t < ttlMs) return false; // outro flush segurando a trava
        }
        localStorage.setItem(LS_LOCK_KEY, JSON.stringify({ t: now }));
        return true;
      }catch{ return true; }
    }
    function releaseLsLock(){ try{ localStorage.removeItem(LS_LOCK_KEY); }catch{} }

    async function withExclusiveLock(fn){
      if (navigator.locks?.request) {
        return navigator.locks.request('presence-flush', {mode:'exclusive'}, fn);
      }
      if (!acquireLsLock()) return;
      try { return await fn(); } finally { releaseLsLock(); }
    }

    function withDB(cb){
      return new Promise((resolve,reject)=>{
        const open=indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded=(e)=>{
          const db=open.result;
          let store;
          if(!db.objectStoreNames.contains(STORE)){
            store = db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
          }else{
            store = e.target.transaction.objectStore(STORE);
          }
          try{
            if (!store.indexNames.contains('clientKey')) {
              store.createIndex('clientKey', 'payload.clientKey', { unique: true });
            }
          }catch(_){}
        };
        open.onsuccess=()=>cb(open.result).then(resolve,reject);
        open.onerror =()=>reject(open.error);
      });
    }

    function hasClientKey(key){
      if (!key) return Promise.resolve(false);
      return withDB(db=>new Promise((res,rej)=>{
        const tx=db.transaction(STORE,'readonly');
        const idx=tx.objectStore(STORE).index('clientKey');
        const req=idx.getKey(key);
        req.onsuccess=()=>res(!!req.result);
        req.onerror =()=>rej(req.error);
      }));
    }

    async function enqueue(payload){
      // evita duplicar na fila pelo mesmo clientKey ou por nonce já enviado
      if (payload?.nonce && sentNonces.has(payload.nonce)) return;
      const key = payload && payload.clientKey;
      if (key && await hasClientKey(key)) return;

      return withDB(db=>new Promise((res,rej)=>{
        const tx=db.transaction(STORE,'readwrite');
        tx.objectStore(STORE).add({payload, createdAt:Date.now()});
        tx.oncomplete=()=>res();
        tx.onerror   =()=>rej(tx.error);
      })).then(()=>{
        dispatchEvent(new CustomEvent('presence:queued', { detail: { payload } }));
        // pede Background Sync sempre que enfileirar
        if (window.requestBackgroundSync) window.requestBackgroundSync('presence-sync');
      });
    }

    function allQueue(){
      return withDB(db=>new Promise((res,rej)=>{
        const out=[]; const tx=db.transaction(STORE,'readonly');
        const cursorReq = tx.objectStore(STORE).openCursor();
        cursorReq.onsuccess=()=>{ const c=cursorReq.result; if(c){ out.push({id:c.key, ...c.value}); c.continue(); } else res(out); };
        cursorReq.onerror =()=>rej(cursorReq.error);
      })).catch(async()=>{
        return withDB(db=>new Promise((res,rej)=>{
          const out=[]; const tx=db.transaction(STORE,'readonly'); const req=tx.objectStore(STORE).openCursor();
          req.onsuccess=()=>{ const c=req.result; if(c){ out.push({id:c.key, ...c.value}); c.continue(); } else res(out); };
          req.onerror =()=>rej(req.error);
        }));
      });
    }

    function removeId(id){
      return withDB(db=>new Promise((res,rej)=>{
        const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(id);
        tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
      }));
    }

    async function postForm(url, data, { timeoutMs=15000 }={}){
      const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeoutMs);
      try{
        const fd=new URLSearchParams(); Object.keys(data||{}).forEach(k=>fd.append(k, data[k]));
        const r=await fetch(url,{ method:'POST', body:fd, redirect:'follow', signal:ctrl.signal });
        if(!r.ok){ throw new Error('http-'+r.status); }
        return await r.text().catch(()=> '');
      } finally { clearTimeout(t); }
    }

    // chave estável do registro (impede duplicata na fila)
    function stableKeyFrom(rec){
      const norm = s => String(s||'').trim().toLowerCase();
      const base = [norm(rec.nome), norm(rec.codigo), norm(rec.evento)].join('|');
      let h = 0; for (let i=0; i<base.length; i++) h = (h*31 + base.charCodeAt(i)) | 0;
      return 'k' + Math.abs(h);
    }

    async function flushPresenceQueue(){
      if (flushing) return flushPromise;
      if (!navigator.onLine) return;

      flushing = true;
      flushPromise = withExclusiveLock(async ()=> {
        const q = await allQueue();
        if(!q.length) return;

        for (const it of q){
          const { id, payload } = it;

          if (payload?.nonce && sentNonces.has(payload.nonce)) { await removeId(id); continue; }

          if (inFlight.has(id)) continue;
          inFlight.add(id);

          try{
            await postForm(ENDPOINT, payload);
            if (payload?.nonce){ sentNonces.add(payload.nonce); saveSentSet(sentNonces); }
            await removeId(id);
            dispatchEvent(new CustomEvent('presence:sent', { detail: { id, payload } }));
          } catch(e){
            // mantém na fila
          } finally {
            inFlight.delete(id);
          }
        }
        renderPending();
      }).finally(()=>{ flushing=false; flushPromise=null; });

      return flushPromise;
    }

    async function registerPresence(payload){
      const enriched = {
        ...payload,
        ua: navigator.userAgent,
        ts: Date.now(),
        clientId: getClientId(),
        nonce: genNonce(),
        clientKey: stableKeyFrom(payload)
      };

      if(navigator.onLine){
        try{
          await postForm(ENDPOINT, enriched);
          if (enriched.nonce){ sentNonces.add(enriched.nonce); saveSentSet(sentNonces); }
          window.PWA_TOAST && PWA_TOAST.show({ title:'Presença', text:'Registro enviado com sucesso.', kind:'success' });
          // >>> importante: delega flush das pendências ao SW (ou faz local se não houver SW)
          flushDebounced();
          dispatchEvent(new CustomEvent('presence:sent-now', { detail: { payload: enriched } }));
          return { ok:true, queued:false };
        }catch(e){
          console.warn('[PWA] Envio online falhou, enfileirando:', e);
        }
      }

      await enqueue(enriched);
      window.PWA_TOAST && PWA_TOAST.show({ title:'Presença', text:'Sem conexão. Registro salvo e será enviado quando a conexão voltar.', kind:'warn', ms:5000 });
      renderPending();
      return { ok:false, queued:true };
    }

    const pendTbody = () => document.getElementById('tabela-pendentes');
    async function renderPending(){
      const body = pendTbody(); if(!body) return;
      const list = await allQueue();
      body.innerHTML = '';
      if(!list.length){ body.innerHTML = '<tr><td colspan="5" style="padding:8px">Sem pendências</td></tr>'; return; }
      list.sort((a,b)=>b.createdAt - a.createdAt).forEach(it=>{
        const { payload } = it;
        const tr = document.createElement('tr');
        const when = new Date(payload.ts || it.createdAt).toLocaleString('pt-BR');
        tr.innerHTML = `<td style="padding:8px">${when}</td><td style="padding:8px">${payload.nome||''}</td><td style="padding:8px">${payload.codigo||''}</td><td style="padding:8px">${payload.evento||''}</td><td style="padding:8px"><span class="badge" style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef2ff;color:#1d4ed8">aguardando</span></td>`;
        body.appendChild(tr);
      });
    }
    addEventListener('presence:queued', renderPending);
    addEventListener('presence:sent', renderPending);
    addEventListener('presence:sent-now', renderPending);
    window.addEventListener('online', renderPending);
    window.addEventListener('offline', renderPending);
    window.addEventListener('load', renderPending);

    window.registerPresence   = registerPresence;
    window.flushPresenceQueue = flushPresenceQueue;
    window.presenceQueueAPI   = {
      all: allQueue,
      hasPending: async () => (await allQueue()).length > 0
    };
  })();

  /* ========= DOWNLOAD (PNG/PDF) ========= */
  async function downloadCard(type='png'){
    if(!window.html2canvas){ alert('html2canvas não disponível offline até a primeira visita em HTTPS.'); return; }
    renderAll();
    const el=document.getElementById('cardFront'); if(!el) return;
    const canvas=await html2canvas(el,{backgroundColor:null,scale:4,useCORS:true,allowTaint:true});
    if(type==='png'){
      triggerDownload(canvas.toDataURL('image/png'),'cartao.png');
    }else{
      if(!window.jspdf||!window.jspdf.jsPDF){ alert('jsPDF não disponível offline até a primeira visita em HTTPS.'); return; }
      const {jsPDF}=window.jspdf;
      const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:[px2mm(CONFIG.CARD_WIDTH),px2mm(CONFIG.CARD_HEIGHT)]});
      pdf.addImage(canvas.toDataURL('image/jpeg',0.95),'JPEG',0,0,px2mm(CONFIG.CARD_WIDTH),px2mm(CONFIG.CARD_HEIGHT));
      pdf.save('cartao.pdf');
    }
  }
  function triggerDownload(url,filename){
    const a=document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  window.downloadCard = downloadCard;

  /* ========= DIAGNÓSTICO / RESET ========= */
  function runDiagnostics(){
    const statusBar = document.getElementById('statusBar');
    if (!statusBar) return;
    function say(s){ statusBar.textContent = s; }
    const checks = [];
    checks.push(`HTTPS:${location.protocol === 'https:'}`);
    checks.push(`html5-qrcode:${!!window.Html5Qrcode}`);
    checks.push(`QRCode:${!!window.QRCode}`);
    checks.push(`JsBarcode:${!!window.JsBarcode}`);
    checks.push(`SW:${'serviceWorker' in navigator}`);
    checks.push(`Top-level:${window.top === window.self}`);
    say(checks.join(' | '));
    if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      navigator.mediaDevices.enumerateDevices()
        .then(list => {
          const cams = list.filter(d => d.kind === 'videoinput').length;
          say(statusBar.textContent + ` | Câmeras:${cams}`);
        })
        .catch(() => {
          say(statusBar.textContent + ' | enumerateDevices ERRO');
        });
    }
  }
  window.runDiagnostics = runDiagnostics;

  async function resetAppData() {
    // Mantemos a função, mas sem gesto oculto para acioná-la.
    try { await stopQR(); } catch {}
    try { localStorage.clear && localStorage.clear(); } catch {}
    try {
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch {}
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const reg of regs) { try { await reg.unregister(); } catch {} }
      }
    } catch {}
    try {
      if (window.indexedDB && typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        await Promise.all((dbs || []).map(db => new Promise(resolve => {
          if (!db || !db.name) return resolve();
          const req = indexedDB.deleteDatabase(db.name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        })));
      }
    } catch {}
    location.reload();
  }
  window.resetAppData = resetAppData;

  /* ========= SAVE & RESTORE LAUNCH CONTEXT ========= */
  (function(){
    const isStandalone = () =>
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    try {
      if (location.search && !isStandalone()) {
        const ctx = { search: location.search, path: location.pathname || '/', ts: Date.now() };
        localStorage.setItem('pwa:lastCtx', JSON.stringify(ctx));
      }
    } catch {}
    try {
      const RESTORE_FLAG = 'pwa:restored';
      if (isStandalone() && !sessionStorage.getItem(RESTORE_FLAG)) {
        const raw = localStorage.getItem('pwa:lastCtx');
        if (raw) {
          const { search, path, ts } = JSON.parse(raw) || {};
          const ONE_WEEK = 7*24*60*60*1000;
          const fresh = !ts || (Date.now() - ts) < ONE_WEEK;
          if (fresh && search && path) {
            const target = path + search;
            const current = location.pathname + location.search;
            if (current !== target) {
              sessionStorage.setItem(RESTORE_FLAG, '1');
              location.replace(target);
            }
          }
        }
      }
    } catch {}
  })();

  /* ========= POSTMESSAGE (integrações) ========= */
  window.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.type === 'badgeData') {
      setBadgeData(d.name, d.code, d.photoUrl);
      if (d.name && d.code) { cacheUserProfileSmart({ fullName: d.name, memberId: d.code, photo: d.photoUrl }).catch(()=>{}); }
    }
  });

  /* ========= BOOTSTRAP ========= */
  function showLoader(){ const l=document.getElementById('loader'); if(l){ l.classList.add('show'); } }
  function hideLoader(){ const l=document.getElementById('loader'); if(l){ l.style.opacity='0'; l.style.transition='opacity .25s'; setTimeout(()=>l.remove(),250); } }

  async function bootstrap(){
    setTimeout(showLoader, 200);

    if (!supports3D) document.body.classList.add('no-3d');
    setBgImageById('bg', CONFIG.BG_BASE64);
    setBgImageById('bgBack', CONFIG.BG_BACK_BASE64);
    setImageSrcById('logoMain', CONFIG.LOGO_MAIN_BASE64);
    setImageSrcById('foot1', CONFIG.LOGO_FOOTER1_BASE64);
    setImageSrcById('foot2', CONFIG.LOGO_FOOTER2_BASE64);
    await prefillFromCacheThenURL();
    renderAll();
    fitPreviewToContainer();
    setStatusOfflineUI();

    if (currentData.name && currentData.code) {
      try { await cacheUserProfileSmart({ fullName: currentData.name, memberId: currentData.code, photo: currentData.photoUrl }); } catch {}
    }

    setTimeout(hideLoader, 650);

    if (typeof window.updateSyncStatus === 'function') window.updateSyncStatus();

    // Eventos de UI (flip, formulário, campo evento bloqueado)
    const card3d=document.getElementById('card3d');
    const flipToBack=document.getElementById('flipToBack');
    const flipToFront=document.getElementById('flipToFront');
    const form=document.getElementById('form');
    const nomeInput=document.getElementById('nome');
    const codigoInput=document.getElementById('codigo');
    const eventoInput=document.getElementById('evento');

    function showBack(){ card3d.classList.add('is-back'); flipToFront.style.display='inline-grid'; setTimeout(fitPreviewToContainer,50); }
    function showFront(){ card3d.classList.remove('is-back'); flipToFront.style.display='none'; setTimeout(fitPreviewToContainer,50); }

    flipToBack?.addEventListener('click', ()=>{
      if (nomeInput) nomeInput.value=currentData.name||'';
      if (codigoInput) codigoInput.value=currentData.code||'';
      flipKeepingViewport(()=>{ showBack(); startQR(); });
      if(window.presenceQueueAPI && window.presenceQueueAPI.all){ dispatchEvent(new CustomEvent('presence:queued')); }
      runDiagnostics();
    });
    flipToFront?.addEventListener('click', ()=>{ flipKeepingViewport(()=>{ showFront(); stopQR(); }); });

    ['keydown','keypress','keyup','paste','drop','input','focus'].forEach(evt=>{
      eventoInput?.addEventListener(evt,e=>{
        if(evt!=='focus') e.preventDefault();
        if(evt==='focus') eventoInput.blur();
        return false;
      },true);
    });

    // Submit do verso (com trava anti duplo-clique)
    form?.addEventListener("submit", async (e)=>{
      e.preventDefault();
      if (submitBusy) return;
      submitBusy = true;

      try{
        const bip=document.getElementById('bip');
        if(!eventoValido || !eventoInput?.value.trim()){
          mostrarMensagem("Leia o QR do evento para prosseguir.", true);
          return;
        }
        const registro={
          nome:(nomeInput?.value||"").trim(),
          codigo:(codigoInput?.value||"").trim(),
          evento:(eventoInput?.value||"").trim(),
          horario:new Date().toLocaleString("pt-BR")
        };
        window.PROC && PROC.pending('Aguarde: processando registro digital…');
        try{
          const res=await window.registerPresence(registro);
          if(res && res.ok){
            mostrarMensagem("Presença registrada com sucesso!", false);
            try{bip&&bip.play();}catch{}
            window.PROC&&PROC.success('Registro realizado com sucesso!');
          }else{
            mostrarMensagem("Sem conexão estável. Registro salvo e será enviado automaticamente.", true);
            window.PROC&&PROC.queued('Sem internet: registro será enviado quando a conexão voltar.');
          }
        }catch(err){
          console.warn('[PWA] Envio online falhou, enfileirando:', err);
          mostrarMensagem("Não foi possível registrar agora. Salvamos e tentaremos novamente.", true);
          window.PROC&&PROC.queued('Registro salvo. Enviaremos quando a conexão voltar.');
        }
        if (eventoInput) eventoInput.value="";
        eventoValido=false;
      } finally {
        setTimeout(()=>{ submitBusy=false; }, 1200);
      }
    });

    // === FLUSH IMEDIATO ao abrir, mais batimento e background sync ===
    if (navigator.onLine) flushDebounced(); // delega ao SW
    startFlushHeartbeat();
    requestBackgroundSync();
    requestPeriodicSync();
  }
  document.addEventListener('DOMContentLoaded', bootstrap);

  /* ========= GLOBAL LISTENERS ========= */
  window.addEventListener('resize',fitPreviewToContainer);
  window.addEventListener('orientationchange',fitPreviewToContainer);
  window.addEventListener('online', ()=>{
    setStatusOfflineUI();
    flushDebounced(); // delega ao SW ao ficar online
    startFlushHeartbeat();
    if (window.updateSyncStatus) window.updateSyncStatus();
    requestBackgroundSync();
  });
  window.addEventListener('offline', ()=>{ setStatusOfflineUI(); if (window.updateSyncStatus) window.updateSyncStatus(); });

  // Sincroniza fila quando volta o foco — com debounce (prioriza SW)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine && typeof window.flushPresenceQueue==='function') flushDebounced();
  });

  /* ========= INSTALL BANNER + SW ========= */
  (function(){
    const banner = document.getElementById('pwaBanner');
    const installBtn = document.getElementById('pwaInstallBtn');
    const closeBtn = document.getElementById('pwaCloseBtn');
    const hint = document.getElementById('pwaHint');

    const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
    const UA = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(UA);
    const isAndroid = /android/.test(UA);
    const isSafari = /^((?!chrome|crios|fxios|edgios|android).)*safari/.test(navigator.userAgent);
    const isChrome = /chrome|crios/.test(navigator.userAgent) && !/edg/i.test(navigator.userAgent);
    const isEdge = /edg\//i.test(navigator.userAgent);

    let deferredPrompt;

    function showBanner(){ if (!isStandalone()) { banner.classList.add('show'); banner.style.display='block'; } }
    function hideBanner(){ banner.classList.remove('show'); setTimeout(()=>{ banner.style.display='none'; }, 200); }

    function setHintTextForPlatform() {
      if (isIOS && isSafari) { hint.innerHTML = 'iPhone/iPad: Compartilhar → <strong>Adicionar à Tela de Início</strong>.'; return; }
      if (!isIOS && isSafari){ hint.innerHTML = 'Safari (macOS): Arquivo → <strong>Adicionar à Dock</strong>.'; return; }
      if (isAndroid && isChrome){ hint.innerHTML = 'Android/Chrome: menu ⋮ → <strong>Instalar app</strong>.'; return; }
      if (isAndroid && isEdge){ hint.innerHTML = 'Android/Edge: menu ⋮ → <strong>Instalar este site como app</strong>.'; return; }
      hint.textContent = 'Procure “instalar/adicionar à tela inicial” no menu do navegador.';
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferredPrompt = e;
      setHintTextForPlatform(); installBtn.style.display = 'inline-block'; showBanner();
    });

    window.addEventListener('load', () => {
      if (isStandalone()) return;
      setTimeout(() => { if (!deferredPrompt) { setHintTextForPlatform(); installBtn.style.display = 'none'; showBanner(); } }, 1800);
    });

    installBtn?.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      hideBanner();
    });

    closeBtn?.addEventListener('click', hideBanner);

    window.addEventListener('appinstalled', () => {
      hideBanner();
      window.PWA_TOAST && PWA_TOAST.show({ title:'Instalação', text:'App instalado com sucesso.', kind:'success' });
    });

    // Service Worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', async () => {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                try { newWorker.postMessage({ type: 'SKIP_WAITING' }); } catch {}
              }
            });
          });

          let hasRefreshed = false;
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (hasRefreshed) return;
            hasRefreshed = true;
            location.reload();
          });
        } catch (e) {
          // opcional: console.warn('SW register error', e);
        }
      });
    }
  })();

})();
