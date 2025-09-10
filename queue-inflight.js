/* queue-inflight.js - shared helpers for inflight state in IndexedDB */
(() => {
  'use strict';
  const DB_NAME = 'cracha-db';
  const STORE = 'presenceQueue';

  function withDB(cb){
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 4);
      open.onupgradeneeded = (e) => {
        const db = open.result;
        let store;
        if(!db.objectStoreNames.contains(STORE)){
          store = db.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
        }else{
          store = e.target.transaction.objectStore(STORE);
        }
        try{
          if(!store.indexNames.contains('clientKey')){
            store.createIndex('clientKey', 'payload.clientKey', { unique:true });
          }
        }catch{}
      };
      open.onsuccess = () => cb(open.result).then(resolve, reject);
      open.onerror  = () => reject(open.error);
    });
  }

  function updateInflight(id, on){
    return withDB(db => new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const get = store.get(id);
      get.onsuccess = () => {
        const rec = get.result;
        if(!rec){ res(); return; }
        rec.inflight = !!on;
        rec.inflightAt = on ? Date.now() : null;
        const put = store.put(rec);
        put.onsuccess = () => res();
        put.onerror  = () => rej(put.error);
      };
      get.onerror = () => rej(get.error);
    }));
  }

  function clearStaleInflight(maxAgeMs = 3*60*1000){
    const now = Date.now();
    return withDB(db => new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const req = st.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if(c){
          const v = c.value || {};
          if(v.inflight && (!v.inflightAt || (now - v.inflightAt) > maxAgeMs)){
            v.inflight = false;
            v.inflightAt = null;
            c.update(v);
          }
          c.continue();
        } else res();
      };
      req.onerror = () => rej(req.error);
    }));
  }

  self.updateInflight = updateInflight;
  self.clearStaleInflight = clearStaleInflight;
})();
