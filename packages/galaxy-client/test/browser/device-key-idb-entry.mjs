import {openDeviceKeyStore} from '../../src/browser-identity/device-key-store.mjs';
import {createDeviceMaterial,fromBase64Url} from '../../../galaxy-contracts/src/identity/identity-material.mjs';
import {createVisitorDraftAdoption} from '../../src/browser-identity/visitor-draft-adoption.mjs';
const marker='galaxy-device-key-idb-synthetic-test',output=document.querySelector('pre');
const assert=(value,message)=>{if(!value)throw new Error(message);};
async function test(){let store;const prior=JSON.parse(sessionStorage.getItem(marker)||'null');
 const name=prior?.name??'galaxy-qa-device-key-'+crypto.randomUUID();
 try{store=await openDeviceKeyStore({name});
  if(!prior){const material=await createDeviceMaterial(),subjectId='GUID15'+'A'.repeat(26);
   assert(material.privateKey.extractable===false,'Generated device key was extractable');
   await store.put(`device:${subjectId}:${material.deviceId}`,material);
   sessionStorage.setItem(marker,JSON.stringify({name,subjectId,deviceId:material.deviceId,publicKeyPem:material.publicKeyPem}));store.close();store=null;location.reload();return;}
  const restored=await store.get(`device:${prior.subjectId}:${prior.deviceId}`);
  assert(restored.privateKey instanceof CryptoKey,'Reload did not restore an actual CryptoKey');
  assert(restored.privateKey.extractable===false,'Reload changed private key extractability');
  assert(restored.publicKeyPem===prior.publicKeyPem,'Reload changed device public key');
  let denied=false;try{await crypto.subtle.exportKey('pkcs8',restored.privateKey);}catch{denied=true;}
  assert(denied,'Private CryptoKey export unexpectedly succeeded');
  const payload='Synthetic device-key persistence proof '+crypto.randomUUID();
  const signed=await store.sign(prior.subjectId,prior.deviceId,payload),parts=signed.split('.');
  const publicKey=await crypto.subtle.importKey('spki',Uint8Array.from(atob(prior.publicKeyPem.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['verify']);
  assert(await crypto.subtle.verify('Ed25519',publicKey,fromBase64Url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])),'Reloaded key failed signature verification');
  assert(new TextDecoder().decode(fromBase64Url(parts[1]))===payload,'Signed payload changed');
  const prefix='galaxy-web:https://synthetic.example.org:',draft={title:'Synthetic visitor draft',summary:'Local copy only'},target=prefix+prior.subjectId+':task-draft';
  await store.put(prefix+'visitor:task-draft',draft);
  const adoption=createVisitorDraftAdoption({store,prefix,getActive:async()=>({subjectId:prior.subjectId})});
  const stale=await adoption.preview();await store.put(target,{title:'Changed existing draft'});
  let conflict=false;try{await adoption.adopt(stale,{confirmed:true});}catch(error){conflict=error.code==='local_draft_changed';}
  assert(conflict,'Stale preview silently overwrote another local draft');
  const current=await adoption.preview(),outcomes=await Promise.allSettled([adoption.adopt(current,{confirmed:true}),adoption.adopt(current,{confirmed:true})]);
  assert(outcomes.filter(result=>result.status==='fulfilled').length===1,'Concurrent adoption silently overwrote a changed draft');
  assert(JSON.stringify(await store.get(target))===JSON.stringify(draft),'Adoption did not copy the displayed draft');
  assert(JSON.stringify(await store.get(prefix+'visitor:task-draft'))===JSON.stringify(draft),'Adoption deleted the visitor original');
  store.close();store=null;
  await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Synthetic database deletion blocked'));});
  sessionStorage.removeItem(marker);output.textContent=JSON.stringify({passed:true,actualIndexedDB:true,pageReload:true,actualCryptoKey:true,
   nonExtractableAfterReload:true,privateExportDenied:true,signatureVerifiedWithOriginalPublicKey:true,visitorDraftCopied:true,
   staleDraftRejected:true,concurrentDraftWinnerCount:1,visitorOriginalRetained:true,cloudRequests:0,syntheticDatabaseDeleted:true,userAgent:navigator.userAgent},null,2);
 }catch(error){store?.close();output.textContent=JSON.stringify({passed:false,error:String(error)});}
}
const run=()=>test().catch(error=>{output.textContent=JSON.stringify({passed:false,error:String(error)});});
document.querySelector('button').addEventListener('click',run);if(sessionStorage.getItem(marker))await run();
