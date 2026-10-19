const prefix='galaxy-official-account:return:';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function path(value,website,{allowIdentity=false}={}){
 if(typeof value!=='string'||value.length>2048||!value.startsWith('/app/'))return null;
 try{const decoded=decodeURIComponent(value);if(decoded.includes('\\')||Array.from(decoded).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return null;
  const target=new URL(value,website);if(target.origin!==website||!target.pathname.startsWith('/app/')||!allowIdentity&&target.pathname==='/app/settings/identity')return null;
  return target.pathname+target.search+target.hash;
 }catch{return null;}
}

// This tab-local record carries navigation only. Its reference never proves
// account login, grants identity control, or changes a credential destination.
export function rememberOfficialAccountReturn(target,returnTo,{website=globalThis.location?.origin,storage,now=()=>Date.now(),randomUUID=()=>crypto.randomUUID()}={}){
 const destination=path(target,website,{allowIdentity:true}),original=path(returnTo,website);
 if(!destination||!original||destination===original)return destination??'/app/account';
 try{const id=randomUUID();if(!uuid(id))return destination;
  (storage??globalThis.sessionStorage).setItem(prefix+id,JSON.stringify({version:1,target:destination,returnTo:original,expiresAt:now()+600000}));
  const result=new URL(destination,website);result.searchParams.set('accountReturn',id);return result.pathname+result.search+result.hash;
 }catch{return destination;}
}

export function restoredOfficialAccountReturn(location,{storage,now=()=>Date.now()}={}){
 try{const current=new URL(location.pathname+location.search+location.hash,location.origin),ids=current.searchParams.getAll('accountReturn');
  if(ids.length!==1||!uuid(ids[0]))return null;
  const record=JSON.parse((storage??globalThis.sessionStorage).getItem(prefix+ids[0])??'null');
  if(record?.version!==1||!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=now()||record.expiresAt>now()+600000)return null;
  current.searchParams.delete('accountReturn');current.searchParams.delete('accountLogin');
  const target=path(record.target,location.origin,{allowIdentity:true}),original=path(record.returnTo,location.origin);
  if(!target||!original||target!==current.pathname+current.search+current.hash)return null;
  return original;
 }catch{return null;}
}
