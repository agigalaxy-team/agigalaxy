import {createDiscoveryClient} from './client.mjs';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sameId=(a,b)=>uuid(a)&&uuid(b)&&a.toLowerCase()===b.toLowerCase();

/** Only the existing clients' acknowledged business operations enter here.
 * Source lookup is deliberately anonymous, independent of the author's or
 * bookmark owner's broader access. No source text is copied into an event.
 * @param {{endpoint:string,accountId:string,websiteOrigin?:string,fetcher?:typeof fetch,now?:()=>number}} options
 */
export function createPublicCommunityFeedback({endpoint,accountId,websiteOrigin=globalThis.location?.origin,fetcher=globalThis.fetch,now=()=>Math.floor(Date.now()/1000)}){
 if(!uuid(accountId))throw Error('Confirmed feedback requires its original account');
 const usage=createDiscoveryClient({endpoint,websiteOrigin,fetcher}),deliveries=new Map();
 /** @param {'post'|'reply'} kind @param {string} id @param {string|null} expectedVersion */
 async function currentReference(kind,id,expectedVersion){
  const response=await fetcher(endpoint+'/v2/community/'+(kind==='post'?'posts/':'replies/')+id,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
  if(!response.ok||Number(response.headers.get('content-length'))>1048576)return null;
  const text=await response.text();if(new TextEncoder().encode(text).length>1048576)return null;
  let view;try{view=JSON.parse(text);}catch{return null;}
  if(view?.availability!=='available'||!Number.isSafeInteger(view.publishedUntil)||view.publishedUntil<=now())return null;
  const locator=view.locator;let version;
  if(kind==='post'){
   if(locator?.kind!=='post'||!sameId(locator.postId,id)||!uuid(view.currentVersionId))return null;
   version=view.currentVersionId.toLowerCase();
  }else{
   if(locator?.kind!=='reply'||!sameId(locator.replyId,id)||view.parentAvailability!=='available'||!Number.isSafeInteger(view.revision)||view.revision<1||locator.contentRevision!==view.revision)return null;
   version=String(view.revision);
  }
  if(expectedVersion!==null&&version!==expectedVersion)return null;
  return {kind,id:id.toLowerCase(),version};
 }
 /** @param {'content-bookmark'|'content-participate'} name @param {string} operationId @param {'post'|'reply'} kind @param {string} id @param {string|null} [expectedVersion] */
 function deliver(name,operationId,kind,id,expectedVersion=null){
  if(!uuid(operationId)||!uuid(id))return Promise.resolve(false);
  const key=name+':'+operationId.toLowerCase();
  if(deliveries.has(key))return deliveries.get(key);
  const promise=(async()=>{
   try{
    const content=await currentReference(kind,id,expectedVersion);if(!content)return false;
    // The original business operation is the stable event identity. A fresh
    // account session must still belong to that operation's original owner.
    await usage.record({eventId:operationId.toLowerCase(),name,pageKey:'community',content},{expectedAccountId:accountId});
    return true;
   }catch{return false;}
  })();
  deliveries.set(key,promise);return promise;
 }
 return Object.freeze({
  /** @param {any} receipt */
  bookmark(receipt){
   if(receipt?.state!=='acknowledged'||receipt.bookmark?.saved!==true||receipt.bookmark.reference?.kind!=='forum-post')return Promise.resolve(false);
   return deliver('content-bookmark',receipt.operationId,'post',receipt.bookmark.reference.postId);
  },
  /** @param {{kind?:string,receipt?:any}} [value] */
  participation({kind,receipt}={}){
   if(!['create-post','publish-version','create-reply'].includes(kind)||receipt?.status!=='acknowledged')return Promise.resolve(false);
   const locator=receipt.locator;
   if(kind==='create-reply'){
    if(locator?.kind!=='reply'||!Number.isSafeInteger(locator.contentRevision)||locator.contentRevision<1)return Promise.resolve(false);
    return deliver('content-participate',receipt.operationId,'reply',locator.replyId,String(locator.contentRevision));
   }
   if(locator?.kind!=='post-version'||!uuid(locator.versionId))return Promise.resolve(false);
   return deliver('content-participate',receipt.operationId,'post',locator.postId,locator.versionId.toLowerCase());
  },
 });
}
