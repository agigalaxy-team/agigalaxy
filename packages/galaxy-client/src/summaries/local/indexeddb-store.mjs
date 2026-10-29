import {clone,failure} from './helpers.mjs';

// Original per-identity IndexedDB transactions and atomic multi-record migration. Callers keep the same read/update/updateMany/close contract.
export async function openPersonalSummaryStore({indexedDB=globalThis.indexedDB,name='galaxy-personal-summaries-v1'}={}){
 if(!indexedDB)throw failure('indexeddb_unavailable');
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('owners');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 function update(key,updater,mode='readwrite'){return new Promise((resolve,reject)=>{const tx=db.transaction('owners',mode),store=tx.objectStore('owners'),r=store.get(key);let result;
  r.onsuccess=()=>{try{const next=updater(clone(r.result));result=clone(next);if(mode==='readwrite')store.put(next,key);}catch(e){reject(e);tx.abort();}};
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error??failure('local_summary_transaction_aborted'));tx.onabort=()=>reject(tx.error??failure('local_summary_transaction_aborted'));
 });}
  // A legacy room-only draft and its new per-summary destination must move in
  // one real IDB transaction. The updater is synchronous, as for update().
  function updateMany(keys,updater){return new Promise((resolve,reject)=>{
   if(!Array.isArray(keys)||!keys.length||new Set(keys).size!==keys.length){reject(failure('invalid_local_summary_transaction'));return;}
   const tx=db.transaction('owners','readwrite'),ownerStore=tx.objectStore('owners'),values={};let remaining=keys.length,result;
   for(const key of keys){const request=ownerStore.get(key);request.onsuccess=()=>{values[key]=clone(request.result);if(--remaining)return;
    try{const next=updater(clone(values));if(!next||!next.values)throw failure('invalid_local_summary_transaction');
     for(const target of Object.keys(next.values)){if(!keys.includes(target))throw failure('invalid_local_summary_transaction');ownerStore.put(next.values[target],target);}result=clone(next.result);
    }catch(error){reject(error);tx.abort();}};}
   tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error??failure('local_summary_transaction_aborted'));tx.onabort=()=>reject(tx.error??failure('local_summary_transaction_aborted'));
  });}
  return Object.freeze({read:key=>update(key,x=>x,'readonly'),update,updateMany,close:()=>db.close()});
}
