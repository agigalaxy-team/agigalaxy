// Website drafts contain no device keys. Keep them available independently of
// the optional Native identity database and its CryptoKey support.
const unavailable=(code,message)=>Object.assign(new Error(message),{code});
const contentError=()=>unavailable('local_content_storage_unavailable','此浏览器暂时无法保存草稿，请保留当前输入后再试。');
const identityError=()=>unavailable('local_identity_storage_unavailable','本机身份存储暂时不可用，请重新打开本机银河后再试。');

export async function openWebContentStore({indexedDB=globalThis.indexedDB,name='galaxy-web-content-v1'}={}){
 if(!indexedDB)throw contentError();
 const db=await new Promise((resolve,reject)=>{
  const request=indexedDB.open(name,1);let settled=false;
  const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
  const timer=setTimeout(()=>finish(reject,contentError()),8000);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('content'))request.result.createObjectStore('content');};
  request.onerror=()=>finish(reject,contentError());
  request.onsuccess=()=>{if(settled){request.result.close();return;}finish(resolve,request.result);};
 });
 const run=(mode,action)=>new Promise((resolve,reject)=>{
  let tx,request,result;
  try{tx=db.transaction('content',mode);request=action(tx.objectStore('content'));}
  catch(error){reject(error);return;}
  request.onsuccess=()=>{result=request.result;};
  tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error??contentError());
 });
 return Object.freeze({
  get:key=>run('readonly',rows=>rows.get(key)),put:(key,value)=>run('readwrite',rows=>rows.put(value,key)),
  update:(key,change)=>new Promise((resolve,reject)=>{
   if(typeof change!=='function'){reject(Error('local_update_callback_required'));return;}
   let tx,request,result,failure;
   try{tx=db.transaction('content','readwrite');request=tx.objectStore('content').get(key);}
   catch(error){reject(error);return;}
   request.onsuccess=()=>{try{
    const next=change(request.result);
    if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}
    result=structuredClone(next);const save=tx.objectStore('content').put(result,key);save.onerror=()=>{failure=save.error;};
   }catch(error){failure=error;tx.abort();}};
   request.onerror=()=>{failure=request.error;};
   tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(failure??tx.error??contentError());
  }),close:()=>db.close()
 });
}

/** Compose the two real stores without moving or adopting legacy ID content. */
export function createWebStorage({prefix,openIdentityStore,openContentStore=openWebContentStore}){
 let identityPromise=null,contentPromise=null,identityFailed=false,closed=false;
 const unreadContent=new Set();
 const isContent=key=>typeof key==='string'&&(key.startsWith(prefix+'account:')||key.startsWith(prefix+'visitor:community-forum:'));
 const getIdentity=()=>{
  if(closed||identityFailed)return Promise.reject(identityError());
  return identityPromise??=(async()=>{try{
   const value=await openIdentityStore();if(closed){value.close?.();throw identityError();}return value;
  }catch{identityFailed=true;throw identityError();}})();
 };
 const getContent=()=>{
  if(closed)return Promise.reject(contentError());
  if(!contentPromise){const opening=Promise.resolve().then(openContentStore).then(value=>{if(closed){value.close?.();throw contentError();}return value;});
   contentPromise=opening;void opening.catch(()=>{if(contentPromise===opening)contentPromise=null;});}
  return contentPromise;
 };
 const nativeCall=async(method,...args)=>{
  const value=await getIdentity();
  if(typeof value[method]!=='function')throw Error(method==='update'?'local_atomic_update_unavailable':'local_identity_store_method_unavailable');
  try{return await value[method](...args);}catch(error){
   // A failed initial active/history read must not lead on to key reads.
   if(method==='get'){identityFailed=true;throw identityError();}throw error;
  }
 };
 return Object.freeze({
  async get(key){
   if(!isContent(key))return nativeCall('get',key);
   try{const result=await(await getContent()).get(key);unreadContent.delete(key);return result;}
   catch{unreadContent.add(key);return undefined;}
  },
  async put(key,value){
   if(!isContent(key))return nativeCall('put',key,value);
   if(unreadContent.has(key))throw contentError();
   try{return await(await getContent()).put(key,value);}catch{throw contentError();}
  },
  async update(key,change){
   if(!isContent(key))return nativeCall('update',key,change);
   if(unreadContent.has(key))throw contentError();
   let callbackError;
   try{const value=await getContent();if(typeof value.update!=='function')throw Error('local_atomic_update_unavailable');
    return await value.update(key,current=>{try{return change(current);}catch(error){callbackError=error;throw error;}});
   }catch(error){if(error===callbackError)throw error;throw contentError();}
  },
  copyConfirmedDraft(input){
   if(isContent(input.sourceKey)||isContent(input.targetKey))return Promise.reject(Error('local_draft_scope_invalid'));
   return nativeCall('copyConfirmedDraft',input);
  },
  close(){if(closed)return;closed=true;for(const pending of [identityPromise,contentPromise])if(pending)void pending.then(value=>value.close?.(),()=>{});}
 });
}
