import {readingBookmarkReferenceSchema,readingBookmarkKey} from "../../../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs";

let storage;
function journal(){
  if(!storage)storage=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(Error('暂时无法保存收藏，请稍后重试。'));return;}
    const request=indexedDB.open('galaxy-account-bookmarks-v2',1);let settled=false;
    const timer=setTimeout(()=>{if(!settled){settled=true;reject(Error('暂时无法保存收藏，请稍后重试。'));}},8000);
    request.onupgradeneeded=()=>request.result.createObjectStore('pending');
    request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;clearTimeout(timer);resolve(request.result);};
    request.onerror=()=>{if(!settled){settled=true;clearTimeout(timer);reject(request.error);}};
  }).catch(error=>{storage=null;throw error;});
  return storage;
}
const storageKey=(name,owner)=>JSON.stringify([owner,name]);
export const accountBookmarkJournalStore={
  async getLocal(name,owner){
    const db=await journal();return new Promise((resolve,reject)=>{
      const tx=db.transaction('pending','readonly'),request=tx.objectStore('pending').get(storageKey(name,owner));let value;
      request.onsuccess=()=>{value=request.result;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error);
    });
  },
  async updateLocal(name,update,owner){
    const db=await journal();return new Promise((resolve,reject)=>{
      const key=storageKey(name,owner),tx=db.transaction('pending','readwrite'),store=tx.objectStore('pending'),request=store.get(key);let value,error;
      request.onsuccess=()=>{try{value=update(request.result);if(value&&typeof value.then==='function')throw Error('暂时无法保存收藏。');value=structuredClone(value);store.put(value,key);}catch(caught){error=caught;tx.abort();}};
      tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(error??tx.error);
    });
  },
};

const prefix='galaxy-bookmark-login:';
function safePath(value,origin){
  try{const url=new URL(value,origin);return url.origin===origin&&url.pathname.startsWith('/app/')&&!url.pathname.includes('\\')?url.pathname+url.search+url.hash:null;}catch{return null;}
}
/**
 * Stores only the requested locator in this tab. It never proves account login.
 * @param {unknown} reference
 * @param {{saved?:boolean,accountId?:string|null,target?:string,origin?:string,store?:Pick<Storage,'setItem'>,now?:()=>number,randomUUID?:()=>string}} [options]
 */
export function rememberBookmarkLogin(reference,{saved=true,accountId=null,target=location.pathname+location.search+location.hash,origin=location.origin,store=globalThis.sessionStorage,now=()=>Date.now(),randomUUID=()=>crypto.randomUUID()}={}){
  const selected=readingBookmarkReferenceSchema.parse(reference),path=safePath(target,origin);
  if(!path)throw Error('收藏位置暂不可用。');
  const id=randomUUID(),url=new URL(path,origin);url.searchParams.delete('accountLogin');url.searchParams.delete('bookmarkIntent');
  const returnTo=url.pathname+url.search+url.hash;
  store.setItem(prefix+id,JSON.stringify({reference:selected,saved,accountId,returnTo,expiresAt:now()+3600000}));
  url.searchParams.set('bookmarkIntent',id);return url.pathname+url.search+url.hash;
}
export function readBookmarkLogin({current=location,store=globalThis.sessionStorage,now=()=>Date.now()}={}){
  try{
    const url=new URL(current.pathname+current.search+current.hash,current.origin),ids=url.searchParams.getAll('bookmarkIntent');
    if(ids.length!==1||!/^[-0-9a-f]{36}$/i.test(ids[0]))return null;
    const value=JSON.parse(store.getItem(prefix+ids[0])??'null'),parsed=readingBookmarkReferenceSchema.safeParse(value?.reference);
    if(!parsed.success||!Number.isFinite(value.expiresAt)||value.expiresAt<=now())return null;
    url.searchParams.delete('bookmarkIntent');url.searchParams.delete('accountLogin');
    if(value.returnTo!==url.pathname+url.search+url.hash)return null;
    return {id:ids[0],reference:parsed.data,saved:value.saved!==false,accountId:typeof value.accountId==='string'?value.accountId:null};
  }catch{return null;}
}
export function claimBookmarkLogin(intent,accountId,{store=globalThis.sessionStorage}={}){
  const value=JSON.parse(store.getItem(prefix+intent.id)??'null');
  if(!value||value.accountId&&value.accountId!==accountId)return false;
  store.setItem(prefix+intent.id,JSON.stringify({...value,accountId}));return true;
}
export function finishBookmarkLogin(intent,reference,{current=location,store=globalThis.sessionStorage,browserHistory=globalThis.history}={}){
  const pending=readBookmarkLogin({current,store});
  if(!pending||pending.id!==intent.id||readingBookmarkKey(pending.reference)!==readingBookmarkKey(reference))return false;
  store.removeItem(prefix+pending.id);
  const url=new URL(current.pathname+current.search+current.hash,current.origin);url.searchParams.delete('bookmarkIntent');
  browserHistory?.replaceState(browserHistory.state,'',url.pathname+url.search+url.hash);return true;
}
