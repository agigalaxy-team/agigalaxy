import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/http.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {createBrowserClient,browserScopes} from '../src/browser-client.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createIdentityDeviceHandoff} from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import {createDeviceMaterial,createRecoveryMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {createBrowserGenesis} from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';

function memoryStore(){const records=new Map();return {get:async key=>structuredClone(records.get(key)),put:async(key,value)=>{records.set(key,structuredClone(value));}};}

test('two real device proofs share one GUID, preserve public-only transfer and reconcile unknown ACK without replacing Consent',async()=>{
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});
 const clients=[];let local,dropCommit=false,dropConsent=false;const postedConsents=[],wire=[];
 const fetcher=async(url,options)=>{assert.equal(new URL(url).origin,f.bindings.endpoint);wire.push(options.body??'');
  const response=await fetch(local+new URL(url).pathname,options);
  if(new URL(url).pathname==='/v1/consents')postedConsents.push(JSON.parse(options.body).signedIntent);
  if(dropCommit&&new URL(url).pathname==='/v2/identity/control/commit'){dropCommit=false;assert.equal(response.status,200);throw new Error('unknown device ACK');}
  if(dropConsent&&new URL(url).pathname==='/v1/consents'){dropConsent=false;assert.equal(response.status,200);throw new Error('unknown Consent ACK');}
  return response;};
 async function deviceRuntime(material,active=null,store=memoryStore()){
  if(active)await store.put(`device:${active.subjectId}:${material.deviceId}`,material);
  const browser=createBrowserClient({endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys,fetch:fetcher,now:()=>f.now,
   sign:async(text,type)=>{const m=await store.get(`device:${active.subjectId}:${active.deviceId}`);return signIdentityPayload(text,m.privateKey,{type});}});clients.push(browser);
  const handoff=()=>createIdentityDeviceHandoff({endpoint:f.bindings.endpoint,send:browser.send,store,getActive:async()=>active,
   activate:async value=>{browser.disconnect();active=value;},allowedScopes:browserScopes,now:()=>f.now});
  return {browser,store,handoff,getActive:()=>active,async connect(){const state=await f.identityControl.publicState(active.subjectId),d=state.devices.find(x=>x.device_id===active.deviceId);
   return browser.connect({subjectId:active.subjectId,genesisProof:active.genesisProof,installationId:active.installationId,
    scopes:browserScopes.filter(scope=>d.scopes.includes(scope)),control:{deviceId:active.deviceId,keyId:d.key_id,epoch:state.epoch}},{confirmed:true});}};
 }
 try{
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));local=`http://127.0.0.1:${api.address().port}`;
  const root=await createDeviceMaterial(),genesis=await createBrowserGenesis({publicKeyPem:root.publicKeyPem,originCode:'5'}),old=await deviceRuntime(root,
   {subjectId:genesis.id,deviceId:root.deviceId,genesisProof:genesis.genesisProof,installationId:crypto.randomUUID()});
  const control=createIdentityControlClient({endpoint:f.bindings.endpoint,send:old.browser.send,store:old.store,now:()=>f.now,
   signController:text=>signIdentityPayload(text,root.privateKey),signNewDevice:text=>signIdentityPayload(text,root.privateKey)});
  let request={version:2,kind:'bootstrap',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:0,previousEventHash:null,
   signerKeyId:await identityKeyId(root.publicKeyPem),genesisProof:genesis.genesisProof,newDevice:{deviceId:root.deviceId,publicKeyPem:root.publicKeyPem,scopes:['manage-identity',...browserScopes]}};
  await control.confirm(await control.prepare(request),{confirmed:true});await old.connect();
  const recovery=await createRecoveryMaterial(genesis.id);let state=await f.identityControl.publicState(genesis.id);
  request={version:2,kind:'set-recovery',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:state.epoch,previousEventHash:state.chainHead,
   signerKeyId:await identityKeyId(root.publicKeyPem),recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true};
  await control.confirm(await control.prepare(request),{confirmed:true});
  const newer=await deviceRuntime(),join=newer.handoff(),offer=await join.createOffer(genesis.id,{confirmed:true});
  await assert.rejects(old.handoff().approveOffer(offer),/confirmation/);
  const approved=await old.handoff().approveOffer(JSON.stringify(offer),{scopes:['binding','consent'],confirmed:true});
  const changed=structuredClone(approved);changed.request.newDevice.scopes.push('manage-identity');
  await assert.rejects(join.previewApproval(changed),/challenge_changed/);
  assert.deepEqual((await join.previewApproval(approved)).scopes,['binding','consent']);
  dropCommit=true;await assert.rejects(join.acceptApproval(JSON.stringify(approved),{confirmed:true}),/unknown device ACK/);
  assert.equal(newer.getActive(),null,'unknown outcome is not a locally active identity');
  const resumed=newer.handoff(),joined=await resumed.reconcile(offer.operationId);
  assert.equal(joined.activated,true);assert.equal(newer.getActive().subjectId,genesis.id);await newer.connect();
  state=await f.identityControl.publicState(genesis.id);assert.equal(state.epoch,1);assert.equal(state.recovery.generation,1);
  assert.deepEqual(state.genesisProof,genesis.genesisProof);assert.equal(state.devices.length,2);
  assert.equal((await resumed.cancel(offer.operationId,{confirmed:true})).receipt.state,'committed','late cancel cannot pretend device authorization was undone');
  await newer.connect();
  const payloadJson=JSON.stringify({title:'Same exact request after unknown Consent acknowledgement'});
  const prepared=await newer.browser.prepareAuthorization(payloadJson,{action:'assistance.publish',objectId:crypto.randomUUID(),confirmed:true});
  assert.equal(postedConsents.length,0,'prepare only signs locally');await newer.store.put('synthetic-pending-consent',prepared);
  dropConsent=true;await assert.rejects(newer.browser.submitAuthorization(prepared,{confirmed:true}),/unknown Consent ACK/);
  const originalBinding=prepared.intent.bindingId;newer.browser.disconnect();await newer.connect();assert.notEqual(newer.browser.snapshot().bindingId,originalBinding);
  const acknowledged=await newer.browser.submitAuthorization(await newer.store.get('synthetic-pending-consent'),{confirmed:true,reconcile:true});
  assert.equal(acknowledged.consentId,prepared.intent.id);assert.equal(acknowledged.payloadJson,payloadJson);assert.equal(postedConsents.length,1,'reconnect reuses recorded original Consent without re-signing');
  const absent=await newer.browser.prepareAuthorization(payloadJson,{action:'assistance.publish',objectId:crypto.randomUUID(),confirmed:true});
  newer.browser.disconnect();await newer.connect();await assert.rejects(newer.browser.submitAuthorization(absent,{confirmed:true,reconcile:true}),e=>e.code==='consent_reauthorization_required');
  assert.equal(postedConsents.length,1,'absent old binding authorization is not silently replaced');
  const otherReceipt=await fetch(local+'/v2/consents/receipt',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${f.credential}`},body:JSON.stringify({consentId:prepared.intent.id})});
  assert.equal(otherReceipt.status,200);assert.deepEqual(await otherReceipt.json(),{consentId:prepared.intent.id,state:'absent'});
  const denied=await fetch(local+'/v2/consents/receipt',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-invalid-credential'},body:JSON.stringify({consentId:prepared.intent.id})});assert.equal(denied.status,401);
  const restoredMaterial=await createDeviceMaterial(),nextRecovery=await createRecoveryMaterial(genesis.id),restoreStore=memoryStore();
  const restore=createIdentityControlClient({endpoint:f.bindings.endpoint,send:old.browser.send,store:restoreStore,now:()=>f.now,
   signController:text=>signIdentityPayload(text,recovery.privateKey),signNewDevice:text=>signIdentityPayload(text,restoredMaterial.privateKey)});
  request={version:2,kind:'recover',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:state.epoch,previousEventHash:state.chainHead,
   signerKeyId:await identityKeyId(recovery.publicKeyPem),recoveryGeneration:1,nextRecoveryPublicKey:nextRecovery.publicKeyPem,
   newDevice:{deviceId:restoredMaterial.deviceId,publicKeyPem:restoredMaterial.publicKeyPem,scopes:['manage-identity','binding','consent']}};
  await restore.confirm(await restore.prepare(request),{confirmed:true});
  await assert.rejects(newer.browser.reconcileAuthorization(prepared),/access_denied/);
  await assert.rejects(resumed.reconcile(offer.operationId),/no_longer_current/);
  const restored=await deviceRuntime(restoredMaterial,{subjectId:genesis.id,deviceId:restoredMaterial.deviceId,genesisProof:genesis.genesisProof,installationId:crypto.randomUUID()});await restored.connect();
  const retired=await restored.browser.call('/v2/consents/receipt',{consentId:prepared.intent.id});assert.equal(retired.status,'revoked');
  assert.equal(restored.browser.snapshot().subjectId,genesis.id);assert.equal(wire.some(value=>/PRIVATE KEY|galaxy-recovery-v1:/.test(value)),false);
 }finally{clients.forEach(client=>client.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
