import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {verifyIdentityControlChain} from '../src/verification/identity-control.mjs';
import {createNativeRuntime} from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createIdentityDeviceManagement} from '../../galaxy-core/src/domain/identity-device-management.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createRecoveryMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-device-management-continuity-'));
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 // serviceFixture captures its numeric now argument. This isolated control
 // authority and its consumer must share the mutable clock for expiry tests.
 f.identityControl.now=()=>f.now;
 const server=createApi({...f,rateLimit:1000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const local='http://127.0.0.1:'+server.address().port,instances=[],writes=[],wire=[];
 let afterCommit=false,beforeCommit=false,statusOffline=false,onSend=null;
 const fetcher=async(url,options={})=>{
  const path=new URL(url).pathname;assert.equal(new URL(url).origin,f.access.endpoint);
  if(options.body)assert.ok(!/PRIVATE KEY|galaxy-recovery-v1:/.test(options.body));
  if(path.endsWith('/status')&&statusOffline)throw Error('Synthetic original status offline');
  if(path.endsWith('/commit')&&beforeCommit){beforeCommit=false;throw Error('Synthetic commit never dispatched');}
  await onSend?.(path,options);
  const response=await fetch(local+path,options);wire.push({path,method:options.method??'GET'});
  if(path.endsWith('/commit')){writes.push({body:options.body,status:response.status});if(afterCommit){afterCommit=false;assert.equal(response.status,200);throw Error('Synthetic committed ACK lost');}}
  return response;
 };
 const config={endpoint:f.access.endpoint,website:'https://galaxy.example',trustedKeys:f.access.trustedKeys,now:()=>f.now,fetch:fetcher};
 async function native(name,initialize=false){const runtime=await createNativeRuntime({...config,dataDirectory:join(directory,name)});instances.push(runtime);
  if(initialize){await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});}return runtime;
 }
 const old=await native('old',true),first=await old.status(),subjectId=first.identity,oldDeviceId=first.connection.control.deviceId;
 const newer=await native('new'),offer=await newer.device.offer(subjectId,{confirmed:true});
 await newer.device.accept(await old.device.approve(offer,{confirmed:true}),{confirmed:true});await newer.connect({confirmed:true});
 const send=async(url,options={})=>{const res=await fetcher(url,{method:options.method??'POST',headers:{'Content-Type':'application/json'},...(options.bodyJson===undefined?{}:{body:options.bodyJson})});
  const value=await res.json();if(!res.ok)throw Object.assign(Error(value.error),{code:value.error,status:res.status});return value;};
 function management(runtime,store=runtime.store){return createIdentityDeviceManagement({endpoint:config.endpoint,send,store,now:config.now,
  getActive:()=>runtime.store.get('native-active:'+config.endpoint),captureLease:runtime.receiptStatus.captureLease});}
 async function operation(runtime,kind,extra={},signer){
  const active=await runtime.store.get('native-active:'+config.endpoint),state=await f.identityControl.publicState(active.subjectId);
  const material=signer??await runtime.store.get('device:'+active.subjectId+':'+active.deviceId);
  const client=createIdentityControlClient({endpoint:config.endpoint,send,store:runtime.store,now:config.now,
   signController:text=>signIdentityPayload(text,material.privateKey),
   ...(extra.newDevice?{signNewDevice:async text=>signIdentityPayload(text,(await runtime.store.get('device:'+active.subjectId+':'+extra.newDevice.deviceId)).privateKey)}:{})});
  const request={version:2,operationId:crypto.randomUUID(),subjectId:active.subjectId,kind,expectedEpoch:state.epoch,previousEventHash:state.chainHead,
   signerKeyId:await identityKeyId(material.publicKeyPem),...extra};
  return client.confirm(await client.prepare(request),{confirmed:true});
 }
 return{f,old,newer,subjectId,oldDeviceId,newDeviceId:offer.deviceId,directory,writes,wire,management,native,send,operation,
  setAfterCommit:value=>afterCommit=value,setBeforeCommit:value=>beforeCommit=value,setStatusOffline:value=>statusOffline=value,setOnSend:value=>onSend=value,
  async close(){instances.forEach(r=>r.close());server.closeAllConnections();await new Promise(r=>server.close(r));await f.db.close();
   const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep));assert.ok(target.includes('galaxy-device-management-continuity-'));await rm(target,{recursive:true,force:true});}};
}

test('new authorized native device explicitly revokes old device; FS restart reads original lost ACK with no repeated commit',async()=>{
 const x=await fixture();try{
  const client=x.management(x.newer),initial=await x.f.identityControl.publicState(x.subjectId),originalBytes=JSON.stringify(initial.events);
  const current=await client.list();assert.equal(current.canManage,true);assert.equal(current.devices.length,2);assert.equal(current.recoveryConfigured,false);
  const preview=await client.prepareRevoke({deviceId:x.oldDeviceId}),before=x.writes.length;
  assert.equal(preview.target.currentDevice,false);assert.equal(preview.effects.recoveryCode,'not-consumed');assert.equal(preview.control.deviceId,x.newDeviceId);
  await assert.rejects(client.confirm(preview),e=>e.code==='device_management_confirmation_required');assert.equal(x.writes.length,before);
  await assert.rejects(client.confirm(structuredClone(preview),{confirmed:true}),e=>e.code==='device_management_confirmation_required');
  x.setAfterCommit(true);await assert.rejects(client.confirm(preview,{confirmed:true}),/committed ACK lost/);
  const pending=(await client.pending()).active;assert.equal(pending.operationId,preview.operationId);assert.equal(pending.state,'result-unknown');
  await x.newer.close();const restarted=await x.native('new');await restarted.connect({confirmed:true});
  const restored=x.management(restarted),result=await restored.reconcile(preview.operationId);
  assert.equal(result.receipt.state,'committed');assert.equal(result.acceptedOperationOnly,true);assert.equal(result.currentAccessGranted,false);
  assert.equal(x.writes.length,before+1);assert.equal((await restored.pending()).active,null);
  assert.equal((await restored.pending()).history[0].operationId,preview.operationId);
  const after=await x.f.identityControl.publicState(x.subjectId);
  assert.equal(after.epoch,initial.epoch);assert.deepEqual(after.genesisProof,initial.genesisProof);assert.equal(JSON.stringify(after.events.slice(0,initial.events.length)),originalBytes);
  assert.equal(after.devices.find(d=>d.device_id===x.oldDeviceId).status,'revoked');
  assert.equal((await verifyIdentityControlChain(after)).devices.length,1);
  await assert.rejects(x.old.api.call('/v2/consents/receipt',{consentId:crypto.randomUUID()}),/access_denied/);
  await assert.rejects(x.old.connect({confirmed:true}),/current_device_control_required/);
  assert.equal((await restored.current()).devices.find(d=>d.currentDevice).canRevoke,false);
  await assert.rejects(restored.prepareRevoke({deviceId:x.newDeviceId}),e=>e.code==='identity_last_controller');
  const files=await readdir(join(x.directory,'new','native-v2','records'));
  for(const file of files){const bytes=await readFile(join(x.directory,'new','native-v2','records',file),'utf8');assert.ok(!bytes.includes('PRIVATE KEY'));assert.ok(!bytes.includes('galaxy-recovery-v1:'));}
 }finally{await x.close();}
});

test('requested original revoke requires new explicit preview after reconnect; same challenge/commit and operation are retained',async()=>{
 const x=await fixture();try{
  const client=x.management(x.newer),preview=await client.prepareRevoke({deviceId:x.oldDeviceId}),before=x.writes.length;
  x.setBeforeCommit(true);await assert.rejects(client.confirm(preview,{confirmed:true}),/never dispatched/);assert.equal(x.writes.length,before);
  const saved=await x.newer.store.get('identity-operation:'+x.f.access.endpoint+':'+preview.operationId),savedBytes=JSON.stringify(saved.commit),challenge=saved.challenge;
  await x.newer.connect({confirmed:true});
  await assert.rejects(client.confirm(preview,{confirmed:true}),e=>e.code==='device_management_confirmation_required'||e.code==='receipt_status_authority_changed');
  const result=await client.reconcile(preview.operationId);assert.equal(result.receipt.state,'requested');assert.equal(x.writes.length,before);
  const reviewed=await client.prepareRevoke({deviceId:x.oldDeviceId});assert.equal(reviewed.operationId,preview.operationId);assert.equal(reviewed.challengeHash,preview.challengeHash);
  assert.equal((await client.confirm(reviewed,{confirmed:true})).receipt.state,'committed');
  const after=await x.newer.store.get('identity-operation:'+x.f.access.endpoint+':'+preview.operationId);
  assert.equal(after.challenge,challenge);assert.equal(JSON.stringify(after.commit),savedBytes);assert.equal(x.writes.length,before+1);
 }finally{await x.close();}
});

test('queued old-connection management calls and an in-flight stored preview cannot cross a native reconnect',{timeout:30000},async()=>{
 const x=await fixture();try{
  let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let trap=true;
  const store={...x.newer.store,get:async key=>{const value=await x.newer.store.get(key);if(trap&&key.startsWith('identity-device-management:')){trap=false;entered();await gate;}return value;}};
  const client=x.management(x.newer,store),before=x.writes.length;
  const preparing=client.prepareRevoke({deviceId:x.oldDeviceId}),queued=client.prepareRevoke({deviceId:x.oldDeviceId});
  const outcomes=Promise.allSettled([preparing,queued]);await started;await x.newer.connect({confirmed:true});release();
  const result=await outcomes;assert.ok(result.every(r=>r.status==='rejected'&&r.reason.code==='receipt_status_authority_changed'));assert.equal(x.writes.length,before);
  assert.equal((await client.pending()).active,null);
  const preview=await client.prepareRevoke({deviceId:x.oldDeviceId});await x.newer.connect({confirmed:true});
  await assert.rejects(client.confirm(preview,{confirmed:true}),e=>e.code==='receipt_status_authority_changed');assert.equal(x.writes.length,before);
  const row=(await client.pending()).active;assert.equal(row.operationId,preview.operationId);assert.equal(row.state,'prepared');
 }finally{await x.close();}
});

test('actual competing control and recovery invalidate the prepared scope; old device approvals never survive a new epoch',async()=>{
 const x=await fixture();try{
  const client=x.management(x.newer),preview=await client.prepareRevoke({deviceId:x.oldDeviceId}),before=x.writes.length;
  const recovery=await createRecoveryMaterial(x.subjectId);
  await x.operation(x.old,'set-recovery',{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true});
  await assert.rejects(client.confirm(preview,{confirmed:true}),e=>e.code==='device_management_control_changed');
  assert.equal(x.writes.length,before+1);assert.equal((await client.pending()).active.state,'prepared');
  assert.equal((await client.stopRetry(preview.operationId,{confirmed:true})).serverCancellationConfirmed,false);
  const fresh=await client.prepareRevoke({deviceId:x.oldDeviceId}),newMaterial=await x.newer.store.createDevice(),nextRecovery=await createRecoveryMaterial(x.subjectId);
  await x.newer.store.put('device:'+x.subjectId+':'+newMaterial.deviceId,newMaterial);
  let recovered=false;const prior=x.writes.length;
  x.setOnSend(async path=>{if(!recovered&&path.endsWith('/challenges')){recovered=true;x.setOnSend(null);
   await x.operation(x.newer,'recover',{recoveryGeneration:1,nextRecoveryPublicKey:nextRecovery.publicKeyPem,
    newDevice:{deviceId:newMaterial.deviceId,publicKeyPem:newMaterial.publicKeyPem,scopes:['manage-identity',...browserScopes]}},recovery);}});
  await assert.rejects(client.confirm(fresh,{confirmed:true}),/control_epoch_changed|identity_control_stale/);
  assert.equal(x.writes.filter(w=>w.status===200).length,prior+1,'only the actual recovery was accepted');
  const after=await x.f.identityControl.publicState(x.subjectId);assert.equal(after.epoch,2);
  assert.equal(after.devices.find(d=>d.device_id===x.newDeviceId).status,'revoked');
  assert.equal(after.recovery.generation,2);assert.equal(after.recoveryReadiness,'registered-awaiting-save-declaration');
  assert.equal((await verifyIdentityControlChain(after)).devices[0].deviceId,newMaterial.deviceId);
 }finally{await x.close();}
});

test('stop unknown preserves body-free original locator and never cancels or repeats; another owner cannot read the journal',async()=>{
 const x=await fixture();try{
  const client=x.management(x.newer),preview=await client.prepareRevoke({deviceId:x.oldDeviceId}),before=x.writes.length;
  x.setBeforeCommit(true);await assert.rejects(client.confirm(preview,{confirmed:true}),/never dispatched/);
  x.setStatusOffline(true);await assert.rejects(client.reconcile(preview.operationId),/status offline/);assert.equal(x.writes.length,before);
  const stopped=await client.stopRetry(preview.operationId,{confirmed:true});assert.equal(stopped.localRetryStopped,true);assert.equal(stopped.serverCancellationConfirmed,false);
  assert.equal(stopped.receipt,null);assert.equal(stopped.state,'result-unknown');
  const pending=(await client.pending()).active;assert.equal(pending.operationId,preview.operationId);assert.equal(pending.localRetryStopped,true);
  assert.ok(!JSON.stringify(pending).includes('controllerSignature'));assert.ok(!JSON.stringify(pending).includes('"challenge":'));
  await assert.rejects(client.prepareRevoke({deviceId:x.oldDeviceId}),e=>e.code==='device_management_local_retry_stopped');assert.equal(x.writes.length,before);
  const foreign=await x.native('foreign',true),other=x.management(foreign,x.newer.store);
  assert.equal((await other.pending()).active,null);await assert.rejects(other.reconcile(preview.operationId),e=>e.code==='device_management_operation_unavailable');
  x.setStatusOffline(false);const status=await client.reconcile(preview.operationId);assert.equal(status.receipt.state,'requested');assert.equal(status.localRetryStopped,true);
  assert.equal(x.writes.filter(w=>JSON.parse(w.body).operationId===preview.operationId).length,0);
  const stored=await x.newer.store.get('identity-operation:'+x.f.access.endpoint+':'+preview.operationId);assert.equal(stored.state,'requested');assert.ok(stored.commit.controllerSignature);
 }finally{await x.close();}
});

test('server-confirmed challenge expiry closes only the old operation; a new explicit review can revoke with current control',async()=>{
 const x=await fixture();try{
  const client=x.management(x.newer),preview=await client.prepareRevoke({deviceId:x.oldDeviceId}),before=x.writes.length;
  x.setBeforeCommit(true);await assert.rejects(client.confirm(preview,{confirmed:true}),/never dispatched/);
  x.f.now+=181;const result=await client.reconcile(preview.operationId);assert.equal(result.receipt.state,'expired');assert.equal(x.writes.length,before);
  assert.equal((await client.pending()).active,null);assert.equal((await client.pending()).history[0].state,'expired');
  const current=await client.prepareRevoke({deviceId:x.oldDeviceId});assert.notEqual(current.operationId,preview.operationId);
  assert.equal((await client.confirm(current,{confirmed:true})).receipt.state,'committed');assert.equal(x.writes.length,before+1);
 }finally{await x.close();}
});

test('explicit self revocation with a registered recovery key records success without claiming current access or recovered data',async()=>{
 const x=await fixture();try{
  await x.operation(x.newer,'revoke-device',{deviceId:x.oldDeviceId});
  const recovery=await createRecoveryMaterial(x.subjectId);await x.operation(x.newer,'set-recovery',{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true});
  const client=x.management(x.newer),state=await client.current();assert.equal(state.recoveryReadiness,'registered-save-declared');assert.equal(state.devices.find(d=>d.currentDevice).canRevoke,true);
  const preview=await client.prepareRevoke({deviceId:x.newDeviceId});assert.equal(preview.target.currentDevice,true);
  const result=await client.confirm(preview,{confirmed:true});assert.equal(result.receipt.state,'committed');assert.equal(result.currentAccessGranted,false);
  const current=await client.current();assert.equal(current.canManage,false);assert.equal(current.recoveryConfigured,true);
  assert.equal((await x.f.identityControl.publicState(x.subjectId)).recovery.generation,1);assert.ok(!JSON.stringify({preview,result,current}).includes(recovery.code));
  await assert.rejects(x.newer.api.call('/v2/consents/receipt',{consentId:crypto.randomUUID()}),/access_denied/);
  const reread=await client.reconcile(preview.operationId);assert.equal(reread.recordedLocalReceipt,true);assert.equal(reread.state,'committed');assert.equal(reread.currentAccessGranted,false);
 }finally{await x.close();}
});
