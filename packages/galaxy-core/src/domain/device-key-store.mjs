import { createDeviceMaterial,createRecoveryMaterial,signIdentityPayload } from './identity-material.mjs';

// CryptoKey structured-cloning keeps nonextractable private keys in the user's
// browser. Only explicit caller-produced public requests can leave this module.
export async function openDeviceKeyStore({indexedDB=globalThis.indexedDB,name='galaxy-device-v2',crypto=globalThis.crypto}={}){
  if(!indexedDB)throw new Error('Local IndexedDB key storage is unavailable.');
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);let settled=false;
    const timer=setTimeout(()=>{if(settled)return;settled=true;reject(new Error('Local key storage initialization timed out.'));},8000);
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    request.onupgradeneeded=()=>request.result.createObjectStore('materials');request.onsuccess=()=>finish(resolve,request.result);request.onerror=()=>finish(reject,request.error);});
  const run=(mode,action)=>new Promise((resolve,reject)=>{
    const tx=db.transaction('materials',mode),store=tx.objectStore('materials');let result;
    try {const request=action(store);request.onsuccess=()=>{result=request.result;};request.onerror=()=>reject(request.error);}
    catch(error){tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error??new Error('Local material update failed.'));tx.onerror=()=>reject(tx.error);
  });
  const get=key=>run('readonly',store=>store.get(key)),put=(key,value)=>run('readwrite',store=>store.put(value,key));
  return Object.freeze({
    get,put,close:()=>db.close(),
    async copyConfirmedDraft({sourceKey,targetKey,expectedSource,expectedTarget,confirmed=false}){
      if(!confirmed||typeof sourceKey!=='string'||typeof targetKey!=='string'||sourceKey===targetKey||!sourceKey.endsWith(':task-draft')||!targetKey.endsWith(':task-draft'))throw new Error('Confirm the exact local task draft copy.');
      // Read both versions and write the chosen copy in one IDB transaction.
      // Keep the visitor version; taking a draft is not permission to erase it.
      return new Promise((resolve,reject)=>{const tx=db.transaction('materials','readwrite'),materials=tx.objectStore('materials');
        const source=materials.get(sourceKey),target=materials.get(targetKey);let ready=0,result,error;
        const done=()=>{if(++ready!==2)return;
          if(!source.result||JSON.stringify(source.result)!==JSON.stringify(expectedSource)||JSON.stringify(target.result??null)!==JSON.stringify(expectedTarget??null)){
            error=Object.assign(new Error('local_draft_changed'),{code:'local_draft_changed'});tx.abort();return;}
          materials.put(structuredClone(source.result),targetKey);result={copied:true,sourceRetained:true};};
        source.onsuccess=done;target.onsuccess=done;source.onerror=target.onerror=event=>{error=event.target.error;};
        tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(error??tx.error??new Error('Local draft copy failed.'));
      });
    },
    async createDevice(subjectId){const material=await createDeviceMaterial({crypto});await put(`device:${subjectId}:${material.deviceId}`,material);return {deviceId:material.deviceId,publicKeyPem:material.publicKeyPem};},
    async sign(subjectId,deviceId,payloadText,options={}){const material=await get(`device:${subjectId}:${deviceId}`);if(!material)throw new Error('Device key unavailable.');return signIdentityPayload(payloadText,material.privateKey,{...options,crypto});},
    async prepareRecovery(subjectId,operationId){
      const key=`pending-recovery:${subjectId}:${operationId}`,existing=await get(key);if(existing)return existing;
      const material=await createRecoveryMaterial(subjectId,{crypto}),record={...material,operationId,saveDeclared:false,status:'local-pending-registration'};
      await put(key,record);return record;
    },
    async declareSaved(subjectId,operationId){const key=`pending-recovery:${subjectId}:${operationId}`,record=await get(key);if(!record)throw new Error('Recovery material unavailable.');await put(key,{...record,saveDeclared:true});},
    async recordReceipt(subjectId,operationId,receipt){
      if(receipt.subjectId!==subjectId||receipt.operationId!==operationId||receipt.state!=='committed')throw new Error('Mismatched recovery receipt.');
      const key=`pending-recovery:${subjectId}:${operationId}`,record=await get(key);if(!record)throw new Error('Recovery material unavailable.');
      await put(key,{...record,receipt,status:record.saveDeclared?'registered-save-declared':'registered-awaiting-save-declaration'});
    },
  });
}
