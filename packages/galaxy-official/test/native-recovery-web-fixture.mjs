// Test-only installed-client simulator. Product WebRuntime deliberately has no
// create/recover-ID methods. All control changes below use real public HTTP,
// Ed25519 proofs and the current Native handoff; storage is an explicit fixture.
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createDeviceMaterial,createRecoveryMaterial,importRecoveryMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {nativeOwner,handoffExistingWebIdentity,existingWebFixtureWebsite} from './existing-web-identity-fixture.mjs';
const nativeControllers=new WeakMap();

export async function createNativeRecoveryWebFixture(config,options){
 const now=options.now??(()=>Math.floor(Date.now()/1000)),website=options.website??existingWebFixtureWebsite;
 let web=await createWebRuntime(config,{...options,website});
 let native=nativeControllers.get(options.store);
 const pending=new Map();
 const control=(key,newKey=key)=>createIdentityControlClient({endpoint:config.endpoint,send:web.api.send,store:native.store,now,
  signController:text=>signIdentityPayload(text,key),signNewDevice:text=>signIdentityPayload(text,newKey)});
 const execute=async(kind,fields,key=native.material.privateKey,newKey=key)=>{
  const state=await web.publicControl(native.owner.subjectId),client=control(key,newKey);
  return client.confirm(await client.prepare({version:2,kind,operationId:crypto.randomUUID(),subjectId:native.owner.subjectId,
   expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:await identityKeyId(kind==='recover'?fields.recoveryPublicKey:native.material.publicKeyPem),
   ...Object.fromEntries(Object.entries(fields).filter(([name])=>name!=='recoveryPublicKey'))}),{confirmed:true});
 };
 if((await web.status()).identity){
  // Reload an existing handoff without minting or selecting a different ID.
  // The fixture's Native controller is kept outside the Web store.
  const saved=nativeControllers.get(options.store);
  if(!saved){web.close();throw Error('Native recovery fixture controller missing.');}
  native=saved;await web.agentContinuity.requireCurrent();
 }else {native=await nativeOwner(config.endpoint,web.api.send,now);await handoffExistingWebIdentity(web,{now,website,native});}
 nativeControllers.set(options.store,native);
 const result={};
 for(const name of Object.keys(web))Object.defineProperty(result,name,{enumerable:true,get:()=>web[name]});
 Object.assign(result,{
  // Test-only Native control stimulus, never a production Web capability.
  async revokeSelectedWebDevice({confirmed=false}={}){
   if(confirmed!==true)throw Error('Fixture Native revocation confirmation required.');
   const sourceWeb=web,sourceNative=native,selected=(await sourceWeb.status()).identity;
   const assertSelected=async()=>{
    const current=(await sourceWeb.status()).identity;
    if(web!==sourceWeb||native!==sourceNative||!selected||selected.subjectId!==sourceNative.owner.subjectId
     ||selected.deviceId===sourceNative.owner.deviceId||current?.subjectId!==selected.subjectId||current?.deviceId!==selected.deviceId)
     throw Error('Fixture Native revocation target changed.');
   };
   await assertSelected();await sourceWeb.agentContinuity.requireCurrent();
   const state=await sourceWeb.publicControl(selected.subjectId),signerKeyId=await identityKeyId(sourceNative.material.publicKeyPem);
   await assertSelected();
   const client=createIdentityControlClient({endpoint:config.endpoint,send:sourceWeb.api.send,store:sourceNative.store,now,
    signController:async text=>{await assertSelected();return signIdentityPayload(text,sourceNative.material.privateKey);}});
   const prepared=await client.prepare({version:2,kind:'revoke-device',operationId:crypto.randomUUID(),subjectId:selected.subjectId,
    expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId,deviceId:selected.deviceId});
   await assertSelected();return client.confirm(prepared,{confirmed:true});
  },
  async prepareRecovery(){const material=await createRecoveryMaterial(native.owner.subjectId),operationId=crypto.randomUUID();pending.set(operationId,material);return{code:material.code,subjectId:material.subjectId,operationId};},
  async saveRecovery({operationId,confirmed}){if(!confirmed||!pending.has(operationId))throw Error('Fixture recovery confirmation required.');
   const material=pending.get(operationId),state=await web.publicControl(native.owner.subjectId);
   const receipt=await execute('set-recovery',{recoveryGeneration:state.recovery?.generation??0,nextRecoveryPublicKey:material.publicKeyPem,saveDeclaration:true});pending.delete(operationId);return receipt;},
  async recover(code,{confirmed}){if(!confirmed)throw Error('Fixture Native recovery confirmation required.');
   const recovery=await importRecoveryMaterial(code),state=await web.publicControl(recovery.subjectId),material=await createDeviceMaterial(),next=await createRecoveryMaterial(recovery.subjectId);
   // Recover can intentionally select another controlled subject in boundary
   // tests. It never imports that subject's work into the original journal.
   native={...native,owner:{subjectId:recovery.subjectId,genesisProof:state.genesisProof,deviceId:material.deviceId,installationId:crypto.randomUUID()},material};
   const receipt=await execute('recover',{recoveryGeneration:state.recovery.generation,recoveryPublicKey:recovery.publicKeyPem,
    newDevice:{deviceId:material.deviceId,publicKeyPem:material.publicKeyPem,scopes:['manage-identity',...browserScopes]},nextRecoveryPublicKey:next.publicKeyPem},recovery.privateKey,material.privateKey);
   await native.store.put(`device:${native.owner.subjectId}:${material.deviceId}`,material);
   web.close();await options.store.put(`galaxy-web:${config.endpoint}:active`,null);
   web=await createWebRuntime(config,{...options,website});await handoffExistingWebIdentity(web,{now,website,native});
   nativeControllers.set(options.store,native);pending.set(receipt.operationId,next);return{operationId:receipt.operationId,identity:(await web.status()).identity};},
  async confirmRecoveredCode({operationId,confirmed}){if(!confirmed||!pending.has(operationId))throw Error('Fixture new recovery code must be retained.');
   const state=await web.publicControl(native.owner.subjectId),receipt=await execute('declare-recovery-saved',{recoveryGeneration:state.recovery.generation,saveDeclaration:true});pending.delete(operationId);return receipt;}
 });
 return Object.freeze(result);
}
