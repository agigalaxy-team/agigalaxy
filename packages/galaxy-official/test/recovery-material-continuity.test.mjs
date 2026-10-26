import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createNativeDeviceCoreHost} from './identity-device-native-host-fixture.mjs';
import {createNativeStore} from '../../galaxy-edge-mcp/src/native-v2/store.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createRecoveryMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';

// Actual core identity operations with Native key/journal persistence. There is
// no production displayed-code/atomic-slot Web recovery coordinator to simulate.
async function setup(){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-recovery-control-')),f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false});
 const server=createApi({...f,rateLimit:1000}),sent=[],hooks={dropAck:false,dropBefore:false,statusOffline:false};let native;
 f.identityControl.now=()=>f.now;
 try{
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port,config={endpoint:f.access.endpoint,trustedKeys:f.access.trustedKeys};
  const wire=async(url,options)=>{const path=new URL(url).pathname;if(path==='/v2/identity/control/status'&&hooks.statusOffline)throw Error('synthetic original status unavailable');if(path==='/v2/identity/control/commit'){sent.push(JSON.parse(options.body));if(hooks.dropBefore){hooks.dropBefore=false;throw Error('synthetic interruption before original commit');}}
   const response=await fetch(origin+path,options);if(path==='/v2/identity/control/commit'&&response.ok&&hooks.dropAck){hooks.dropAck=false;await response.text();throw Error('synthetic committed identity ACK lost');}return response;};
  native=await createNativeDeviceCoreHost({directory,config,fetch:wire,now:()=>f.now,initialize:true});
  const owner=await native.store.get('native-active:'+config.endpoint),material=await native.store.get('device:'+owner.subjectId+':'+owner.deviceId);
  const state=()=>native.host.api.call('/v2/identity/'+owner.subjectId+'/control',undefined,{method:'GET',authenticated:false});
  const client=(signer=material,next=signer,{store=native.store,forbidSigning=false}={})=>createIdentityControlClient({endpoint:config.endpoint,send:native.host.api.send,store,now:()=>f.now,
   signController:text=>{if(forbidSigning)throw Error('readonly continuation must not sign');return signIdentityPayload(text,signer.privateKey);},
   signNewDevice:text=>{if(forbidSigning)throw Error('readonly continuation must not sign');return signIdentityPayload(text,next.privateKey);}});
  const request=async(kind,signer,fields)=>{const current=await state();return{version:2,kind,operationId:crypto.randomUUID(),subjectId:owner.subjectId,expectedEpoch:current.epoch,previousEventHash:current.chainHead,signerKeyId:await identityKeyId(signer.publicKeyPem),...fields};};
  const close=async()=>{native.host.close();server.closeAllConnections();await new Promise(done=>server.close(done));await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-recovery-control-'));await rm(target,{recursive:true,force:true});};
  return{...f,native,owner,material,client,request,state,hooks,sent,config,close,advance:seconds=>{f.now+=seconds;}};
 }catch(error){native?.host.close();await Promise.allSettled([(async()=>{if(server.listening){server.closeAllConnections();await new Promise(done=>server.close(done));}})(),f.db.close()]);const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-recovery-control-'));await rm(target,{recursive:true,force:true});throw error;}
}

test('Native core recovery registration persists the exact signed commit; lost ACK reads and retries cannot substitute another operation',async()=>{
 const f=await setup();try{
  const recovery=await createRecoveryMaterial(f.owner.subjectId),input=await f.request('set-recovery',f.material,{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true});
  const original=f.client(),preview=await original.prepare(input);f.hooks.dropAck=true;
  await assert.rejects(original.confirm(preview,{confirmed:true}),/ACK lost/);
  const key='identity-operation:'+f.config.endpoint+':'+input.operationId,stored=await f.native.store.get(key),sent=f.sent.length;
  const restarted=f.client(f.material,f.material,{store:createNativeStore(f.native.directory),forbidSigning:true});
  assert.equal((await restarted.status(input.operationId)).state,'committed');assert.equal(f.sent.length,sent);
  assert.equal((await restarted.retry(input.operationId,{confirmed:true})).state,'committed');assert.equal(f.sent.length,sent+1);assert.deepEqual(f.sent.at(-1),stored.commit);
  await assert.rejects(restarted.prepare({...input,nextRecoveryPublicKey:(await createRecoveryMaterial(f.owner.subjectId)).publicKeyPem}),/different identity change/);assert.equal(f.sent.length,sent+1);
  assert.equal((await f.state()).recovery.publicKeyPem,recovery.publicKeyPem);
  assert.equal(JSON.stringify((await f.db.query('SELECT request,challenge_text FROM identity_control_operations')).rows).includes(recovery.code),false);
  f.hooks.statusOffline=true;const noDispatch=f.sent.length;await assert.rejects(restarted.status(input.operationId),/status unavailable/);assert.equal(f.sent.length,noDispatch);f.hooks.statusOffline=false;
  const replacement=await createRecoveryMaterial(f.owner.subjectId),current=await f.state(),requested=await f.request('set-recovery',f.material,{recoveryGeneration:current.recovery.generation,nextRecoveryPublicKey:replacement.publicKeyPem,saveDeclaration:true});
  const nextClient=f.client(),nextPreview=await nextClient.prepare(requested);f.hooks.dropBefore=true;await assert.rejects(nextClient.confirm(nextPreview,{confirmed:true}),/before original commit/);
  const saved=await f.native.store.get('identity-operation:'+f.config.endpoint+':'+requested.operationId),pending=f.client(f.material,f.material,{store:createNativeStore(f.native.directory),forbidSigning:true});
  assert.equal((await pending.status(requested.operationId)).state,'requested');await pending.retry(requested.operationId,{confirmed:true});assert.deepEqual(f.sent.at(-1),saved.commit);

 }finally{await f.close();}
});

test('Native core recover and save-declaration retain their original signatures after ACK loss, rotate epoch and revoke old devices',async()=>{
 const f=await setup();try{
  const recovery=await createRecoveryMaterial(f.owner.subjectId),registration=f.client();
  await registration.confirm(await registration.prepare(await f.request('set-recovery',f.material,{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true})),{confirmed:true});
  const next=await createRecoveryMaterial(f.owner.subjectId),device=await f.native.store.createDevice(),before=await f.state();
  const input=await f.request('recover',recovery,{recoveryGeneration:before.recovery.generation,newDevice:{deviceId:device.deviceId,publicKeyPem:device.publicKeyPem,scopes:['manage-identity',...browserScopes]},nextRecoveryPublicKey:next.publicKeyPem});
  const client=f.client(recovery,device),preview=await client.prepare(input);f.hooks.dropAck=true;await assert.rejects(client.confirm(preview,{confirmed:true}),/ACK lost/);
  const original=f.sent.at(-1),count=f.sent.length,restarted=f.client(recovery,device,{store:createNativeStore(f.native.directory),forbidSigning:true});
  assert.equal((await restarted.status(input.operationId)).state,'committed');assert.equal(f.sent.length,count);await restarted.retry(input.operationId,{confirmed:true});assert.deepEqual(f.sent.at(-1),original);
  const current=await f.state();assert.equal(current.epoch,before.epoch+1);assert.equal(current.devices.find(row=>row.device_id===f.owner.deviceId).status,'revoked');assert.equal(current.devices.find(row=>row.device_id===device.deviceId).status,'active');assert.equal(current.recovery.publicKeyPem,next.publicKeyPem);
  const declaration=await f.request('declare-recovery-saved',device,{recoveryGeneration:current.recovery.generation,saveDeclaration:true}),declare=f.client(device),display=await declare.prepare(declaration);f.hooks.dropAck=true;
  await assert.rejects(declare.confirm(display,{confirmed:true}),/ACK lost/);const declarationCommit=f.sent.at(-1),sent=f.sent.length;
  const declared=f.client(device,device,{store:createNativeStore(f.native.directory),forbidSigning:true});assert.equal((await declared.status(declaration.operationId)).state,'committed');assert.equal(f.sent.length,sent);await declared.retry(declaration.operationId,{confirmed:true});assert.deepEqual(f.sent.at(-1),declarationCommit);
  assert.equal((await f.state()).recoveryReadiness,'registered-save-declared');
  assert.equal((await f.db.query("SELECT status FROM recovery_authorizations WHERE subject_id=$1 AND public_key=$2",[f.owner.subjectId,recovery.publicKeyPem])).rows[0].status,'consumed');
  const stale=await f.request('declare-recovery-saved',device,{recoveryGeneration:before.recovery.generation,saveDeclaration:true}),events=(await f.db.query('SELECT count(*)::int AS total FROM subject_control_events WHERE subject_id=$1',[f.owner.subjectId])).rows[0].total;
  await assert.rejects(declare.confirm(await declare.prepare(stale),{confirmed:true}),/recovery_generation_consumed/);
  assert.equal((await f.db.query('SELECT count(*)::int AS total FROM subject_control_events WHERE subject_id=$1',[f.owner.subjectId])).rows[0].total,events);

 }finally{await f.close();}
});

test('Native core expiry preserves the original request and forbids unsigned submission while accepted receipts remain readable',async()=>{
 const f=await setup();try{
  const recovery=await createRecoveryMaterial(f.owner.subjectId),input=await f.request('set-recovery',f.material,{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true}),client=f.client(),preview=await client.prepare(input);
  const key='identity-operation:'+f.config.endpoint+':'+input.operationId,original=await f.native.store.get(key),before=f.sent.length;f.advance(181);
  await assert.rejects(client.confirm(preview,{confirmed:true}),/expired/);assert.equal(f.sent.length,before);assert.deepEqual((await f.native.store.get(key)).request,original.request);assert.equal((await f.native.store.get(key)).commit,undefined);

  const signedInput=await f.request('set-recovery',f.material,{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true}),signed=await client.prepare(signedInput);f.hooks.dropBefore=true;await assert.rejects(client.confirm(signed,{confirmed:true}),/before original commit/);
  const signedKey='identity-operation:'+f.config.endpoint+':'+signedInput.operationId,retained=await f.native.store.get(signedKey);f.advance(181);
  const readonly=f.client(f.material,f.material,{forbidSigning:true});assert.equal((await readonly.status(signedInput.operationId)).state,'expired');await assert.rejects(readonly.retry(signedInput.operationId,{confirmed:true}),/identity_challenge_expired/);assert.deepEqual((await f.native.store.get(signedKey)).commit,retained.commit);
  const fresh={...await f.request('set-recovery',f.material,{recoveryGeneration:0,nextRecoveryPublicKey:recovery.publicKeyPem,saveDeclaration:true})};assert.notEqual(fresh.operationId,input.operationId);
  const accepted=await client.confirm(await client.prepare(fresh),{confirmed:true});f.advance(181);const count=f.sent.length;
  assert.equal((await f.client(f.material,f.material,{forbidSigning:true}).status(accepted.operationId)).state,'committed');assert.equal(f.sent.length,count);
  assert.deepEqual((await f.native.store.get(key)).request,original.request);
 }finally{await f.close();}
});

test('Web exposes no retired recovery coordinator or privileged recovery signing path',async()=>{
 const rows=new Map();let requests=0,writes=0;
 const store={get:async key=>structuredClone(rows.get(key)),put:async(key,value)=>{writes++;rows.set(key,structuredClone(value));},update:async(key,change)=>{writes++;const value=change(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);}};
 const now=Math.floor(Date.now()/1000),trustedKeys=new Map([['synthetic-web-denial',{publicKeyPem:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),notBefore:now-1,notAfter:now+3600,revoked:false}]]);
 const web=await createWebRuntime({endpoint:'https://official.example.org',trustedKeys},{store,fetch:async()=>{requests++;throw Error('Web must not dispatch recovery');}});
 try{
  for(const name of ['prepareRecovery','saveRecovery','recover','confirmRecoveredCode','pendingRecoveryCode','pendingIdentityOperations','queryIdentityOperation','continueIdentityOperation'])assert.equal(typeof web[name],'undefined',name);
  const before=writes;await assert.rejects(web.createIdentity(),error=>error.code==='local_galaxy_required');assert.equal(writes,before);assert.equal(requests,0);
 }finally{web.close();}
});
