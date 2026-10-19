import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createAgentIdentityHandoff,readAgentIdentityEntry,agentIdentityReturnPath,methodSearchIdentityContinuation} from '../src/agent-identity-handoff.mjs';

const endpoint='https://official.example.org',website='https://galaxy.example.org',bridgeOrigin='http://127.0.0.1:39841';
const subjectId='GUID10'+'0'.repeat(26),otherId='GUID10'+'1'.repeat(26),protocol='galaxy-web-identity-handoff';
const scopes=['binding','assistance'],allScopes=['manage-identity',...browserScopes];
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let count=0;count<200;count++){if(check())return;await tick();}assert.ok(check(),'asynchronous consumer reached the expected state');}
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture({existing=false,pending=null,additionalDevice=false}={}){
 const native=await createDeviceMaterial(),browser=await createDeviceMaterial(),nativeKey=await identityKeyId(native.publicKeyPem),browserKey=await identityKeyId(browser.publicKeyPem);
 const previous=additionalDevice?await createDeviceMaterial():browser,previousKey=await identityKeyId(previous.publicKeyPem);
 const entry={valid:true,handoffId:crypto.randomUUID(),navigationId:crypto.randomUUID(),bridgeOrigin,targetPath:'/app/tasks/'+crypto.randomUUID()+'?section=apply#draft',website};
 const node=(material,keyId)=>({device_id:material.deviceId,key_id:keyId,public_key:material.publicKeyPem,epoch:1,status:'active',scopes:allScopes});
 const state={identity:existing?{subjectId,deviceId:previous.deviceId}:null,connection:null,control:{authority:endpoint,subjectId,epoch:1,chainHead:'a'.repeat(64),devices:[node(native,nativeKey),...(existing?[{...node(previous,previousKey),scopes:additionalDevice?['binding']:allScopes}]:[])]},pending,acceptGate:null,connectGate:null};
 const calls={read:0,offer:0,preview:0,accept:0,select:0,connect:0,retained:0,receipt:0,checked:0,returned:[]},packets=[],updates=[],listeners=new Set();
 const opener={closed:false,postMessage:(packet,target)=>packets.push({packet:structuredClone(packet),target})};
 const host={opener,addEventListener:(name,listener)=>{if(name==='message')listeners.add(listener);},removeEventListener:(name,listener)=>listeners.delete(listener),setInterval,clearInterval};
 const runtime={api:{endpoint},receiptStatus:{captureLease:()=>{const identity=state.identity,connection=state.connection;return{assertCurrent:()=>{if(identity!==state.identity||connection!==state.connection)throw Object.assign(new Error('changed'),{code:'receipt_status_authority_changed'});}};}},
  status:async()=>structuredClone({identity:state.identity,connection:state.connection,endpoint}),publicControl:async()=>{calls.read++;return structuredClone(state.control);},
  agentContinuity:{retainHandoff:async()=>{calls.retained++;},retainReceipt:async()=>{calls.receipt++;},requireCurrent:async()=>{calls.checked++;}},
  connect:async()=>{calls.connect++;if(state.connectGate)await state.connectGate.promise;state.connection={subjectId:state.identity.subjectId,endpoint,bindingId:crypto.randomUUID(),generation:1,control:{deviceId:state.identity.deviceId,epoch:state.control.epoch},scopes};return structuredClone(state.connection);},
  deviceHandoff:{pending:async()=>state.pending,createOffer:async(id,options)=>{calls.offer++;assert.equal(id,subjectId);assert.deepEqual(options,{scopes,confirmed:true});return{version:1,type:'galaxy-device-request',endpoint,subjectId,operationId:crypto.randomUUID(),deviceId:browser.deviceId,publicKeyPem:browser.publicKeyPem,scopes};},
   previewOffer:async value=>({...value,fingerprint:browserKey}),previewApproval:async value=>{calls.preview++;return{subjectId,operationId:value.offer.operationId,deviceId:browser.deviceId,scopes};},
   acceptApproval:async value=>{calls.accept++;if(state.acceptGate)await state.acceptGate.promise;state.control.chainHead='b'.repeat(64);state.control.devices.push(node(browser,browserKey));state.pending={state:additionalDevice?'awaiting-result':'committed',operationId:value.offer.operationId,approval:value};
    if(additionalDevice)return{activated:false,needsLocalDeviceSelection:true};state.identity={subjectId,deviceId:browser.deviceId};return{activated:true};},
   previewLocalDeviceSelection:async operationId=>({endpoint,subjectId,operationId,previousDeviceId:previous.deviceId,deviceId:browser.deviceId,scopes,fingerprint:browserKey}),
   selectLocalDevice:async(value,options)=>{assert.equal(options.confirmed,true);assert.equal(state.identity.deviceId,value.previousDeviceId);calls.select++;state.identity={subjectId,deviceId:browser.deviceId};state.pending.state='committed';return{activated:true,identity:state.identity,receipt:{state:'committed',operationId:value.operationId,subjectId}};}}};
 const consumer=createAgentIdentityHandoff({runtime,entry,window:host,now:()=>1000,onUpdate:value=>updates.push(value),onConnected:value=>calls.returned.push(value)});consumer.start();await until(()=>packets.some(row=>row.packet.kind==='ready'));
 const message=(kind,payload,overrides={})=>{const event={origin:bridgeOrigin,source:opener,data:{protocol,version:1,handoffId:entry.handoffId,navigationId:entry.navigationId,kind,payload},...overrides};for(const listener of listeners)listener(event);};
 async function context({key=native,changes={}}={}){
  const {nonce,existingDevice}=packets.find(row=>row.packet.kind==='ready').packet.payload;
  const body={endpoint,website,subjectId,controller:{deviceId:native.deviceId,keyId:nativeKey,epoch:1,chainHead:'a'.repeat(64)},scopes,expiresAt:1120,targetPath:entry.targetPath,existingDevice,...changes};
  const payloadJson=JSON.stringify({protocol,version:1,handoffId:entry.handoffId,navigationId:entry.navigationId,nonce,bridgeOrigin,context:body});
  return{...body,nonce,bridgeOrigin,proof:{payloadJson,signature:await signIdentityPayload(payloadJson,key.privateKey,{type:'galaxy-web-identity-handoff-v1+jws'})}};
 }
 const offered=()=>packets.find(row=>row.packet.kind==='offer')?.packet.payload;
 return{entry,native,browser,previous,state,calls,packets,updates,host,opener,runtime,consumer,message,context,offered,stop:()=>consumer.close()};
}

test('URL locators accept only exact loopback origin and a same-site non-identity original target',()=>{
 const base=new URL(website+'/app/settings/identity');base.search=new URLSearchParams({agentConnect:crypto.randomUUID(),agentNavigation:crypto.randomUUID(),agentBridgeOrigin:bridgeOrigin,returnTo:'/app/publish?sourceTask=x#draft'});
 assert.equal(readAgentIdentityEntry(base).targetPath,'/app/publish?sourceTask=x#draft');
 for(const bad of['http://localhost:39841','https://127.0.0.1:39841','http://127.0.0.1:0','http://127.0.0.1:39841/','http://user@127.0.0.1:39841','http://127.0.0.1:39841?token=x']){const copy=new URL(base);copy.searchParams.set('agentBridgeOrigin',bad);assert.equal(readAgentIdentityEntry(copy).valid,false);}
 const duplicate=new URL(base);duplicate.searchParams.append('agentConnect',crypto.randomUUID());assert.equal(readAgentIdentityEntry(duplicate).valid,false);
 for(const target of['https://elsewhere.example/app/','//elsewhere.example/app/','/app/settings/identity','/app/settings/identity/','/other','/\\elsewhere/app/'])assert.equal(agentIdentityReturnPath(target,website),null);
 assert.equal(readAgentIdentityEntry(new URL(website+'/app/settings/identity')),null);
});

test('method search continuation retains the exact query and original task without alternate targets or extra fields',()=>{
 const taskId=crypto.randomUUID(),query='为当前阅读项目查找可用方法',target=methodSearchIdentityContinuation(taskId,query),base=new URL(website+'/app/settings/identity');
 base.search=new URLSearchParams({agentConnect:crypto.randomUUID(),agentNavigation:crypto.randomUUID(),agentBridgeOrigin:bridgeOrigin,returnTo:target});
 assert.equal(readAgentIdentityEntry(base).targetPath,target);
 const parsed=new URL(target,website);assert.equal(parsed.searchParams.get('q'),query);assert.equal(parsed.searchParams.get('sourceTask'),taskId);
 for(const changed of[target+'&type=capsule',target+'&q=changed',target+'#other',target.replace(taskId,crypto.randomUUID()),target.replace(encodeURIComponent(`/app/tasks/${taskId}?section=collaboration`),encodeURIComponent('/app/publish'))]){
  const entry=new URL(base);entry.searchParams.set('returnTo',changed);assert.equal(readAgentIdentityEntry(entry).valid,false);
 }
 for(const value of['','  ',query+' ',query+'\n','x'.repeat(201)])assert.equal(methodSearchIdentityContinuation(taskId,value),null);
 assert.equal(methodSearchIdentityContinuation('not-a-task',query),null);
});

test('account association is the sole identity return destination and rejects recursive or extra query targets',()=>{
 const accepted='/app/settings/identity?section=account',base=new URL(website+'/app/settings/identity');
 base.search=new URLSearchParams({agentConnect:crypto.randomUUID(),agentNavigation:crypto.randomUUID(),agentBridgeOrigin:bridgeOrigin,returnTo:accepted});
 assert.equal(agentIdentityReturnPath(accepted,website),accepted);assert.equal(readAgentIdentityEntry(base).targetPath,accepted);
 for(const target of[accepted+'#other',accepted+'&returnTo=%2Fapp%2Faccount',accepted+'&section=access','/app/settings/identity?section=access','/app/settings/identity/child?section=account'])assert.equal(agentIdentityReturnPath(target,website),null);
});

test('unrelated windows, origins and correlations cannot trigger reads or keys; verified repeated context creates one public offer',async t=>{
 const f=await fixture();t.after(f.stop);const context=await f.context();
 f.message('context',context,{source:{}});f.message('context',context,{origin:website});f.message('context',context,{data:{protocol,version:1,handoffId:crypto.randomUUID(),navigationId:f.entry.navigationId,kind:'context',payload:context}});
 await tick();assert.equal(f.calls.read,0);assert.equal(f.calls.offer,0);
 f.message('context',context);f.message('context',context);await until(()=>!!f.offered());assert.equal(f.calls.offer,1);
 assert.ok(f.packets.every(row=>row.target===bridgeOrigin));assert.ok(!JSON.stringify(f.packets).includes('PRIVATE KEY'));assert.equal(f.calls.accept,0);
});

test('native proof rejects wrong signer, nonce, changed head and unbound extra context before an offer',async t=>{
 for(const attack of['signer','nonce','head','extra'])await t.test(attack,async sub=>{
  const f=await fixture();sub.after(f.stop);const value=await f.context(attack==='signer'?{key:f.browser}:{});
  if(attack==='nonce')value.nonce=crypto.randomUUID();if(attack==='head')f.state.control.chainHead='f'.repeat(64);if(attack==='extra')value.credential='not-a-credential';
  f.message('context',value);await until(()=>f.consumer.snapshot().phase==='stopped');assert.equal(f.calls.offer,0);assert.equal(f.calls.connect,0);assert.equal(f.calls.accept,0);
 });
});

test('same-GUID shortcut still proves current Native key and independently current browser device before actual connect',async t=>{
 const f=await fixture({existing:true});t.after(f.stop);f.message('context',await f.context());await until(()=>f.calls.returned.length===1);
 assert.equal(f.calls.offer,0);assert.equal(f.calls.connect,1);const receipt=f.packets.find(row=>row.packet.kind==='completed').packet.payload;
 assert.deepEqual(receipt,{operationId:null,subjectId,deviceId:f.browser.deviceId,epoch:1,chainHead:'a'.repeat(64),connected:true});assert.equal(f.calls.returned[0].targetPath,f.entry.targetPath);
});

test('different browser GUID is preserved and an unresolved old operation cannot use the null shortcut',async t=>{
 const other=await fixture({existing:true});t.after(other.stop);other.state.identity.subjectId=otherId;other.message('context',await other.context());await until(()=>other.consumer.snapshot().phase==='stopped');assert.equal(other.state.identity.subjectId,otherId);assert.equal(other.calls.offer,0);assert.equal(other.calls.connect,0);
 const unknown=await fixture({existing:true,pending:{state:'awaiting-result',approval:{public:true}}});t.after(unknown.stop);unknown.message('context',await unknown.context());await until(()=>unknown.consumer.snapshot().phase==='stopped');assert.equal(unknown.consumer.snapshot().code,'agent_handoff_original_result_pending');assert.equal(unknown.calls.connect,0);assert.ok(unknown.state.pending.approval);
});

test('only exact owned offer goes through existing preview/accept; completed uses fresh control and returns exact target',async t=>{
 const f=await fixture();t.after(f.stop);f.message('context',await f.context());await until(()=>!!f.offered());const approval={offer:f.offered(),existingPublicApprovalFixture:true};
 f.message('approval',approval);f.message('approval',approval);await until(()=>f.calls.returned.length===1);
 assert.equal(f.calls.preview,1);assert.equal(f.calls.accept,1);assert.equal(f.calls.connect,1);assert.equal(f.packets.find(row=>row.packet.kind==='completed').packet.payload.chainHead,'b'.repeat(64));assert.equal(f.state.identity.subjectId,subjectId);
});

test('same-GUID additional permission waits for one explicit local device choice and returns the original page once',async t=>{
 const f=await fixture({existing:true,additionalDevice:true});t.after(f.stop);f.message('context',await f.context());await until(()=>!!f.offered());
 const approval={offer:f.offered()};f.message('approval',approval);await until(()=>f.consumer.snapshot().phase==='choose-device');
 assert.equal(f.state.identity.deviceId,f.previous.deviceId);assert.equal(f.calls.select,0);assert.equal(f.calls.connect,0);assert.equal(f.calls.returned.length,0);
 assert.deepEqual(f.consumer.snapshot().localDeviceSelection.scopes,scopes);f.message('approval',approval);
 await Promise.all([f.consumer.selectLocalDevice(),f.consumer.selectLocalDevice()]);
 assert.equal(f.calls.accept,1);assert.equal(f.calls.select,1);assert.equal(f.calls.connect,1);assert.equal(f.calls.returned.length,1);
 assert.equal(f.state.identity.deviceId,f.browser.deviceId);assert.equal(f.calls.returned[0].targetPath,f.entry.targetPath);assert.equal(f.calls.returned[0].operationId,f.offered().operationId);
});

test('an obsolete or stopped local device choice cannot switch the browser or return a stale completion',async t=>{
 for(const reason of['owner-change','stop'])await t.test(reason,async sub=>{
  const f=await fixture({existing:true,additionalDevice:true});sub.after(f.stop);f.message('context',await f.context());await until(()=>!!f.offered());
  f.message('approval',{offer:f.offered()});await until(()=>f.consumer.snapshot().phase==='choose-device');
  if(reason==='stop')f.consumer.cancel();else f.state.identity={subjectId,deviceId:crypto.randomUUID()};
  await f.consumer.selectLocalDevice();assert.equal(f.calls.select,0);assert.equal(f.calls.connect,0);assert.equal(f.calls.returned.length,0);assert.ok(f.state.pending.approval);
 });
});

test('stop during accepted request prevents late connect/return while retaining the original operation',async t=>{
 const f=await fixture();t.after(f.stop);f.message('context',await f.context());await until(()=>!!f.offered());f.state.acceptGate=gate();f.message('approval',{offer:f.offered()});await until(()=>f.calls.accept===1);
 f.consumer.cancel();f.state.acceptGate.resolve();await until(()=>f.state.pending?.state==='committed');await tick();assert.equal(f.calls.connect,0);assert.equal(f.calls.returned.length,0);assert.ok(f.state.pending.approval);assert.equal(f.packets.filter(row=>row.packet.kind==='completed').length,0);
});

test('changing browser identity during connect or losing opener cannot return a stale completion',async t=>{
 const f=await fixture({existing:true});t.after(f.stop);f.state.connectGate=gate();f.message('context',await f.context());await until(()=>f.calls.connect===1);
 f.state.identity={subjectId:otherId,deviceId:crypto.randomUUID()};f.state.connectGate.resolve();await until(()=>f.consumer.snapshot().phase==='stopped');assert.equal(f.calls.returned.length,0);assert.equal(f.packets.filter(row=>row.packet.kind==='completed').length,0);
 const lost=await fixture();t.after(lost.stop);lost.message('context',await lost.context());await until(()=>!!lost.offered());lost.opener.closed=true;lost.message('approval',{offer:lost.offered()});await until(()=>lost.consumer.snapshot().phase==='stopped');assert.equal(lost.calls.accept,0);
});
