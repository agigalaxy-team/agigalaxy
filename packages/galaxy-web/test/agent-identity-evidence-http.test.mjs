import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {migrate} from '../../galaxy-official/src/database.mjs';
import {createServices} from '../../galaxy-official/src/services.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createWebRuntime} from '../src/runtime.mjs';
import {seedExistingWebIdentity} from '../../galaxy-official/test/existing-web-identity-fixture.mjs';
import {createIdentityControlClient} from '../../galaxy-core/src/domain/identity-control-client.mjs';
import {createIdentityDeviceHandoff} from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import {createBrowserGenesis} from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import {createDeviceMaterial,identityKeyId,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {taskDraft,ordinaryPublicationFromDraft} from '../src/task-bounty-client.mjs';

const website='https://galaxy.example.org',bridgeOrigin='http://127.0.0.1:39841',allScopes=['manage-identity',...browserScopes];
const {PGlite}=createRequire(new URL('../../galaxy-official/package.json',import.meta.url))('@electric-sql/pglite');
function memoryStore(){const records=new Map();return{records,get:async key=>structuredClone(records.get(key)),put:async(key,value)=>records.set(key,structuredClone(value)),
 update:async(key,change)=>{const value=change(structuredClone(records.get(key)));records.set(key,structuredClone(value));return structuredClone(value);}};}

async function fixture(t,{trustSeconds=200000}={}){
 let clock=Math.floor(Date.now()/1000);const db=new PGlite();await migrate(db);const server=generateKeyPairSync('ed25519'),endpoint='https://official.example.org';
 const services=createServices({db,endpoint,kid:'fixture',signingKey:server.privateKey,allowedScopes:browserScopes,now:()=>clock,operator:'Isolated fixture',region:'test',
  trustedKeys:new Map([['fixture',{publicKeyPem:server.publicKey.export({type:'spki',format:'pem'}),notBefore:clock-1,notAfter:clock+trustSeconds,revoked:false}]])});
 // This fixture isolates identity continuity. Public Account verification and
 // production quotas remain outside this evidence and are never bypassed in app code.
 services.assistance.publicWrites={consumeWithin:async()=>({syntheticFixture:true,verificationNotTested:true}),markInvitationRespondedWithin:async()=>{}};
 const f={...services,db,get now(){return clock;}},api=createApi({...f,rateLimit:10000});
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+api.address().port;
 const clients=[],calls=[],drop={identity:false,taskBefore:false,taskAfter:false,consentBefore:false,eventBefore:false,eventAfter:false,signatureBefore:false};
 const fetcher=async(url,options)=>{const path=new URL(url).pathname;assert.equal(new URL(url).origin,f.bindings.endpoint);calls.push({path,method:options.method,body:options.body});
  if(drop.taskBefore&&path==='/v2/tasks'){drop.taskBefore=false;throw Error('controlled task before delivery');}
  if(drop.consentBefore&&path==='/v1/consents'){drop.consentBefore=false;throw Error('controlled consent before delivery');}
  const taskEvent=/^\/v2\/(tasks\/[0-9a-f-]{36}\/(events|participations)|participations\/[0-9a-f-]{36}\/events)$/.test(path);
  if(drop.eventBefore&&taskEvent){drop.eventBefore=false;throw Error('controlled task event before delivery');}
  const response=await fetch(local+path,options);
  if(drop.identity&&path==='/v2/identity/control/commit'){drop.identity=false;assert.equal(response.status,200);throw Error('controlled identity ACK lost');}
  if(drop.taskAfter&&path==='/v2/tasks'){drop.taskAfter=false;assert.equal(response.status,200);throw Error('controlled task ACK lost');}
  if(drop.eventAfter&&taskEvent){drop.eventAfter=false;assert.equal(response.status,200);throw Error('controlled task event ACK lost');}
  return response;
 };
 const config={endpoint:f.bindings.endpoint,trustedKeys:f.bindings.trustedKeys};
  async function web(store=memoryStore(),{initialize=false}={}){
  const journal={...store,get:async key=>{
   if(drop.signatureBefore&&key.startsWith('device:')&&[...store.records.values()].some(row=>row?.state==='prepared'&&typeof row.payloadJson==='string'&&!row.preparedConsent)){
    drop.signatureBefore=false;throw Error('controlled interruption before original signature');
   }return store.get(key);
  }};
   if(initialize)await seedExistingWebIdentity(config,{store:journal,fetch:fetcher,now:()=>clock});
   const runtime=await createWebRuntime(config,{store:journal,fetch:fetcher,now:()=>clock,website});clients.push(runtime);return{runtime,store};
 }
 const transport=await web(),native=await createDeviceMaterial(),genesis=await createBrowserGenesis({publicKeyPem:native.publicKeyPem,originCode:'5'}),nativeStore=memoryStore();
 const nativeIdentity={subjectId:genesis.id,deviceId:native.deviceId,genesisProof:genesis.genesisProof,installationId:crypto.randomUUID()};await nativeStore.put(`device:${genesis.id}:${native.deviceId}`,native);
 function controlFor(material,store=memoryStore()){return createIdentityControlClient({endpoint:config.endpoint,send:transport.runtime.api.send,store,now:()=>f.now,
  signController:payload=>signIdentityPayload(payload,material.privateKey),signNewDevice:payload=>signIdentityPayload(payload,material.privateKey)});}
 const control=controlFor(native,nativeStore),bootstrap={version:2,kind:'bootstrap',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:0,previousEventHash:null,
  signerKeyId:await identityKeyId(native.publicKeyPem),genesisProof:genesis.genesisProof,newDevice:{deviceId:native.deviceId,publicKeyPem:native.publicKeyPem,scopes:allScopes}};
 await control.confirm(await control.prepare(bootstrap),{confirmed:true});
 const nativeHandoff=createIdentityDeviceHandoff({endpoint:config.endpoint,send:transport.runtime.api.send,store:nativeStore,getActive:async()=>nativeIdentity,activate:async()=>assert.fail('native is not the new browser'),allowedScopes:browserScopes,now:()=>f.now});
 async function signedContext({existingDevice=null,material=native,subjectId=genesis.id}={}){
  const state=await f.identityControl.publicState(subjectId),handoffId=crypto.randomUUID(),navigationId=crypto.randomUUID(),nonce=crypto.randomUUID();
  const context={endpoint:config.endpoint,website,subjectId,controller:{deviceId:material.deviceId,keyId:await identityKeyId(material.publicKeyPem),epoch:state.epoch,chainHead:state.chainHead},
   scopes:allScopes,expiresAt:clock+120,targetPath:'/app/publish?from=original#draft',existingDevice};
  const payloadJson=JSON.stringify({protocol:'galaxy-web-identity-handoff',version:1,handoffId,navigationId,nonce,bridgeOrigin,context});
  return{handoffId,navigationId,context:{...context,nonce,bridgeOrigin,proof:{payloadJson,signature:await signIdentityPayload(payloadJson,material.privateKey,{type:'galaxy-web-identity-handoff-v1+jws'})}}};
 }
 async function offer(browser){const signed=await signedContext(),request=await browser.runtime.deviceHandoff.createOffer(genesis.id,{scopes:allScopes,confirmed:true}),approval=await nativeHandoff.approveOffer(request,{scopes:allScopes,confirmed:true});
  await browser.runtime.agentContinuity.retainHandoff({...signed,offer:request,approval});return{...signed,offer:request,approval};}
 async function authorizeOther(){const next=await createDeviceMaterial(),state=await f.identityControl.publicState(genesis.id),request={version:2,kind:'authorize-device',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:state.epoch,previousEventHash:state.chainHead,
  signerKeyId:await identityKeyId(native.publicKeyPem),newDevice:{deviceId:next.deviceId,publicKeyPem:next.publicKeyPem,scopes:allScopes}};
  const signer=createIdentityControlClient({endpoint:config.endpoint,send:transport.runtime.api.send,store:memoryStore(),now:()=>f.now,signController:payload=>signIdentityPayload(payload,native.privateKey),signNewDevice:payload=>signIdentityPayload(payload,next.privateKey)});
  await signer.confirm(await signer.prepare(request),{confirmed:true});return next;}
 async function revoke(signer,deviceId){const state=await f.identityControl.publicState(genesis.id),request={version:2,kind:'revoke-device',operationId:crypto.randomUUID(),subjectId:genesis.id,expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:await identityKeyId(signer.publicKeyPem),deviceId};
  const client=controlFor(signer);return client.confirm(await client.prepare(request),{confirmed:true});}
 t.after(async()=>{clients.forEach(client=>client.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();});
 return{f,config,drop,calls,native,genesis,web,offer,signedContext,authorizeOther,revoke,advance:seconds=>clock+=seconds};
}
const draft=f=>({caseId:null,intent:'collaboration',title:'Synthetic existing Agent continuity task',summary:'Only isolated signed HTTP evidence',workContext:{goal:'Preserve exact original task policy',currentSituation:'Synthetic verification',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1800});

test('ordinary new requests preserve older draft data and confirmed Task events resume exact content without fees, duplicate execution or stopped revival',async t=>{
 const x=await fixture(t),browser=await x.web(),request=await x.offer(browser);
 const joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});
 await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 const legacy=taskDraft({title:'合成普通新请求',summary:'新请求不建立费用或支付资格',goal:'完成普通协作',situation:'保留旧草稿',visibility:'Private',
  collaboration:'basic-bounty',budgetMode:'range',minimum:'not-a-valid-amount',maximum:'legacy amount',policyKey:'retired-policy@1',unknownLocalNote:'仍保留'},x.f.now);
 const snapshot=JSON.stringify(legacy),input=ordinaryPublicationFromDraft(legacy,x.f.now),published=await browser.runtime.publishTask(input,{confirmed:true});
 assert.equal(JSON.stringify(legacy),snapshot);assert.equal(input.collaboration,'open-assistance');assert.equal(input.budget,undefined);assert.equal(input.qualification,undefined);
 const task=await browser.runtime.api.call(`/v2/tasks/${published.taskId}` ,{}, {method:'GET'});
 assert.equal(task.request.collaboration,'open-assistance');assert.equal(task.request.budget,undefined);assert.equal(task.request.qualification,undefined);
 const event={kind:'extend-enrollment',expectedTaskVersion:1,enrollmentExpiresAt:task.request.enrollmentExpiresAt+3600};
 x.drop.consentBefore=true;await assert.rejects(browser.runtime.taskEvent(task.taskId,event,{confirmed:true}),/controlled consent before delivery/);
 const original=await browser.runtime.getLocal(`task-event:${task.taskId}`),deadline=original.preparedConsent.intent.expiresAt;
 x.advance(301);await browser.runtime.connect({confirmed:true});
 const before=x.calls.length;
 await Promise.all([assert.rejects(browser.runtime.resumeTaskEvent(task.taskId),error=>error.code==='task_operation_authorization_review_required'&&error.reason==='original-binding-changed'),
  assert.rejects(browser.runtime.resumeTaskEvent(task.taskId),error=>error.code==='task_operation_authorization_review_required'&&error.reason==='original-binding-changed')]);
 assert.equal(x.calls.slice(before).some(item=>item.path==='/v1/consents'||item.path===`/v2/tasks/${task.taskId}/events`),false);
 assert.deepEqual(await browser.runtime.getLocal(`task-event:${task.taskId}`),original,'automatic recovery preserves the original signature and bytes');
 const review=await browser.runtime.reviewTaskAuthorization(task.taskId);assert.equal(review.state,'reauthorization-required');
 assert.deepEqual(review.payload,JSON.parse(original.payloadJson));assert.deepEqual(review.viewers,original.viewers);assert.ok(review.expiresAt>deadline);
 await assert.rejects(browser.runtime.reauthorizeTaskOperation(review,{taskId:task.taskId}),/确认/);
 const accepted=await browser.runtime.reauthorizeTaskOperation(review,{taskId:task.taskId,confirmed:true});
 assert.equal(accepted.eventId,original.eventId);assert.equal(accepted.version,2);
 const grants=(await x.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1 AND intent->>'payloadHash'=$2",[original.eventId,original.payloadHash])).rows;
 assert.equal(grants.length,1);assert.equal(grants[0].intent.expiresAt,review.expiresAt);assert.deepEqual(grants[0].intent.viewers,original.viewers);
 assert.equal(await browser.runtime.getLocal(`task-event:${task.taskId}`),null);
 x.drop.eventAfter=true;await assert.rejects(browser.runtime.taskEvent(task.taskId,{...event,expectedTaskVersion:2,enrollmentExpiresAt:task.request.enrollmentExpiresAt+7200},{confirmed:true}),/controlled task event ACK lost/);
 const unknown=await browser.runtime.getLocal(`task-event:${task.taskId}`),writes=x.calls.filter(item=>item.path===`/v2/tasks/${task.taskId}/events`).length;
 assert.equal((await browser.runtime.resumeTaskEvent(task.taskId)).eventId,unknown.eventId);
 assert.equal(x.calls.filter(item=>item.path===`/v2/tasks/${task.taskId}/events`).length,writes);
 x.drop.eventBefore=true;await assert.rejects(browser.runtime.taskEvent(task.taskId,{...event,expectedTaskVersion:3,enrollmentExpiresAt:task.request.enrollmentExpiresAt+10000},{confirmed:true}),/controlled task event before delivery/);
 const stopped=await browser.runtime.reviewTaskStop(task.taskId);await browser.runtime.stopTaskOperation(stopped,{taskId:task.taskId,confirmed:true});
 const stoppedWrites=x.calls.filter(item=>item.path===`/v2/tasks/${task.taskId}/events`).length;
 assert.equal((await browser.runtime.resumeTaskEvent(task.taskId)).state,'none');
 assert.equal((await browser.runtime.queryStoppedTaskOperation(stopped.eventId,{taskId:task.taskId})).receipt.state,'absent');
 assert.equal(x.calls.filter(item=>item.path===`/v2/tasks/${task.taskId}/events`).length,stoppedWrites);
 const saved=(await browser.runtime.stoppedTaskOperations(task.taskId))[0];assert.equal(saved.payloadJson,undefined);assert.equal(saved.preparedConsent,undefined);
});

test('expired original Task event remains pending without a new signature or deadline',async t=>{
 const x=await fixture(t,{trustSeconds:4000000}),browser=await x.web(),request=await x.offer(browser);
 const joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});
 await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 const task=await browser.runtime.publishTask(draft(x.f),{confirmed:true});
 x.drop.consentBefore=true;await assert.rejects(browser.runtime.taskEvent(task.taskId,{kind:'extend-enrollment',expectedTaskVersion:1,enrollmentExpiresAt:x.f.now+3600},{confirmed:true}),/controlled consent before delivery/);
 const original=await browser.runtime.getLocal(`task-event:${task.taskId}`);x.advance(2591901);await browser.runtime.connect({confirmed:true});
 const writes=x.calls.filter(item=>item.path==='/v1/consents'||item.path===`/v2/tasks/${task.taskId}/events`).length;
 await assert.rejects(browser.runtime.resumeTaskEvent(task.taskId),error=>error.code==='task_operation_authorization_expired');
 const retained=await browser.runtime.getLocal(`task-event:${task.taskId}`);assert.equal(retained.payloadJson,original.payloadJson);
 assert.equal(retained.preparedConsent.intent.expiresAt,original.preparedConsent.intent.expiresAt);
 assert.equal(x.calls.filter(item=>item.path==='/v1/consents'||item.path===`/v2/tasks/${task.taskId}/events`).length,writes);
});

test('Task publication preserves stale original authorization until explicit review, then reads an accepted unknown result without repeating it',async t=>{
 const x=await fixture(t),browser=await x.web(),request=await x.offer(browser);
 const joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});
 await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 await browser.runtime.putLocal('task-draft',{title:'An independent unsent request'});
 assert.equal((await browser.runtime.resumePublication()).state,'none');
 x.drop.consentBefore=true;await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),/controlled consent before delivery/);
 const original=await browser.runtime.getLocal('task-publication'),deadline=original.preparedConsent.intent.expiresAt;
 x.advance(301);await browser.runtime.connect({confirmed:true});
 const before=x.calls.length;
 await assert.rejects(browser.runtime.resumePublication(),error=>error.code==='publication_authorization_review_required'&&error.reason==='original-binding-changed');
 assert.equal(x.calls.slice(before).some(item=>item.path==='/v1/consents'||item.path==='/v2/tasks'),false);
 assert.deepEqual(await browser.runtime.getLocal('task-publication'),original);
 const review=await browser.runtime.reviewTaskAuthorization();assert.deepEqual(review.payload,original.payload);assert.ok(review.expiresAt>deadline);
 const result=await browser.runtime.reauthorizeTaskOperation(review,{confirmed:true});assert.equal(result.taskId,original.payload.taskId);assert.equal(result.eventId,original.payload.operationId);
 assert.equal(await browser.runtime.getLocal('task-publication'),null);
 const grant=(await x.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1 AND intent->>'payloadHash'=$2",[result.eventId,original.payloadHash])).rows[0].intent;
 assert.equal(grant.expiresAt,review.expiresAt);assert.equal(grant.payloadHash,original.payloadHash);
 assert.equal((await browser.runtime.getLocal('task-draft')).title,'An independent unsent request');
 x.drop.taskAfter=true;await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),/controlled task ACK lost/);
 const beforeUnknown=x.calls.filter(item=>item.path==='/v2/tasks').length,unknown=await browser.runtime.getLocal('task-publication');
 const acknowledged=await browser.runtime.resumePublication();assert.equal(acknowledged.state,'acknowledged');assert.equal(acknowledged.taskId,unknown.payload.taskId);
 assert.equal(x.calls.filter(item=>item.path==='/v2/tasks').length,beforeUnknown);
});

test('automatic Task recovery keeps legacy unsigned journals without binding evidence read-only and renews only same-binding transport age',async t=>{
 const x=await fixture(t),browser=await x.web(),request=await x.offer(browser),
  joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});
 await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 x.drop.signatureBefore=true;await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),/before original signature/);
 const unsigned=await browser.runtime.getLocal('task-publication');assert.equal(unsigned.preparedConsent,undefined);
 delete unsigned.authorizationBindingId;await browser.runtime.putLocal('task-publication',unsigned);
 let before=x.calls.length;
 await assert.rejects(browser.runtime.resumePublication(),error=>error.code==='publication_authorization_review_required'&&error.reason==='original-binding-unavailable');
 assert.equal(x.calls.slice(before).some(row=>row.path==='/v1/consents'||row.path==='/v2/tasks'),false);
 assert.deepEqual(await browser.runtime.getLocal('task-publication'),unsigned);
 const publicationReview=await browser.runtime.reviewTaskAuthorization();assert.equal(publicationReview.consentId,null);
 assert.deepEqual(publicationReview.payload,unsigned.payload);
 await assert.rejects(browser.runtime.reauthorizeTaskOperation(publicationReview),/确认/);
 const published=await browser.runtime.reauthorizeTaskOperation(publicationReview,{confirmed:true}),taskId=published.taskId;
 const event={kind:'extend-enrollment',expectedTaskVersion:1,enrollmentExpiresAt:x.f.now+86400};
 x.drop.signatureBefore=true;await assert.rejects(browser.runtime.taskEvent(taskId,event,{confirmed:true}),/before original signature/);
 const unsignedEvent=await browser.runtime.getLocal('task-event:'+taskId);assert.equal(unsignedEvent.preparedConsent,undefined);
 delete unsignedEvent.authorizationBindingId;await browser.runtime.putLocal('task-event:'+taskId,unsignedEvent);before=x.calls.length;
 await assert.rejects(browser.runtime.resumeTaskEvent(taskId),error=>error.code==='task_operation_authorization_review_required'&&error.reason==='original-binding-unavailable');
 assert.equal(x.calls.slice(before).some(row=>row.path==='/v1/consents'||row.path===`/v2/tasks/${taskId}/events`),false);
 assert.deepEqual(await browser.runtime.getLocal('task-event:'+taskId),unsignedEvent);
 const eventReview=await browser.runtime.reviewTaskAuthorization(taskId);assert.equal(eventReview.consentId,null);assert.deepEqual(eventReview.payload,JSON.parse(unsignedEvent.payloadJson));
 await assert.rejects(browser.runtime.reauthorizeTaskOperation(eventReview,{taskId}),/确认/);
 assert.equal((await browser.runtime.reauthorizeTaskOperation(eventReview,{taskId,confirmed:true})).eventId,unsignedEvent.eventId);
 x.drop.consentBefore=true;await assert.rejects(browser.runtime.taskEvent(taskId,{...event,expectedTaskVersion:2,enrollmentExpiresAt:x.f.now+172800},{confirmed:true}),/before delivery/);
 const stale=await browser.runtime.getLocal('task-event:'+taskId),bindingId=browser.runtime.api.snapshot().bindingId;x.advance(301);before=x.calls.length;
 assert.equal(browser.runtime.api.snapshot().bindingId,bindingId);
 assert.equal((await browser.runtime.resumeTaskEvent(taskId)).eventId,stale.eventId);
 const eventWrite=x.calls.slice(before).find(row=>row.path===`/v2/tasks/${taskId}/events`);assert.equal(JSON.parse(eventWrite.body).payloadJson,stale.payloadJson);
 const renewed=(await x.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1",[stale.eventId])).rows[0].intent;
 assert.equal(renewed.bindingId,bindingId);assert.equal(renewed.expiresAt,stale.authorizationExpiresAt);assert.notEqual(renewed.id,stale.preparedConsent.intent.id);
});

test('confirmed Task publication and event journals keep their original binding choice through signature interruption and same-binding transport renewal',async t=>{
 const x=await fixture(t),browser=await x.web(),request=await x.offer(browser),joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});
 await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 x.drop.signatureBefore=true;await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),/before original signature/);
 const unsigned=await browser.runtime.getLocal('task-publication');assert.equal(unsigned.authorizationBindingId,browser.runtime.api.snapshot().bindingId);
 const accepted=await browser.runtime.resumePublication();assert.equal(accepted.taskId,unsigned.payload.taskId);
 let grant=(await x.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1",[unsigned.payload.operationId])).rows[0].intent;
 assert.equal(grant.bindingId,unsigned.authorizationBindingId);assert.equal(grant.expiresAt,unsigned.authorizationExpiresAt);
 x.drop.signatureBefore=true;await assert.rejects(browser.runtime.taskEvent(accepted.taskId,{kind:'extend-enrollment',expectedTaskVersion:1,enrollmentExpiresAt:x.f.now+86400},{confirmed:true}),/before original signature/);
 const unsignedEvent=await browser.runtime.getLocal('task-event:'+accepted.taskId);assert.equal((await browser.runtime.resumeTaskEvent(accepted.taskId)).eventId,unsignedEvent.eventId);
 grant=(await x.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1",[unsignedEvent.eventId])).rows[0].intent;
 assert.equal(grant.bindingId,unsignedEvent.authorizationBindingId);assert.equal(grant.expiresAt,unsignedEvent.authorizationExpiresAt);
 x.drop.consentBefore=true;await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),/before delivery/);
 const stale=await browser.runtime.getLocal('task-publication');x.advance(301);const before=x.calls.length;
 assert.equal((await browser.runtime.resumePublication()).taskId,stale.payload.taskId);
 const written=x.calls.slice(before).find(row=>row.path==='/v2/tasks');assert.equal(JSON.parse(written.body).payloadJson,stale.payloadJson);
 grant=(await x.f.db.query("SELECT intent FROM consents WHERE intent->>'objectId'=$1",[stale.payload.operationId])).rows[0].intent;
 assert.equal(grant.expiresAt,stale.authorizationExpiresAt);assert.equal(grant.bindingId,stale.preparedConsent.intent.bindingId);assert.notEqual(grant.id,stale.preparedConsent.intent.id);
});

test('automatic Task continuation keeps expired original publication content without renewing its permission',async t=>{
 const x=await fixture(t,{trustSeconds:4000000}),browser=await x.web(),request=await x.offer(browser);
 const joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});
 await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 x.drop.consentBefore=true;await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),/controlled consent before delivery/);
 const original=await browser.runtime.getLocal('task-publication');x.advance(2591901);await browser.runtime.connect({confirmed:true});
 const count=x.calls.filter(item=>item.path==='/v1/consents'||item.path==='/v2/tasks').length;
 await assert.rejects(browser.runtime.resumePublication(),error=>error.code==='publication_authorization_expired');
 assert.equal(x.calls.filter(item=>item.path==='/v1/consents'||item.path==='/v2/tasks').length,count);
 assert.deepEqual(await browser.runtime.getLocal('task-publication'),original);
});

test('an existing browser identity keeps its draft, but cannot publish/apply/confirm with a forged local flag',async t=>{
  const x=await fixture(t),browser=await x.web(memoryStore(),{initialize:true});await browser.runtime.connect({confirmed:true});
 await browser.runtime.putLocal('task-draft',{title:'Preserve my independent local draft',unknownLegacy:'retained'});
 const identity=(await browser.runtime.status()).identity,before=x.calls.filter(row=>row.path==='/v1/consents').length,taskId=crypto.randomUUID();
 await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),error=>error.code==='agent_identity_required');
 await assert.rejects(browser.runtime.taskEvent(taskId,{kind:'apply',expectedTaskVersion:1,proposal:'Synthetic help',scope:'Defined scope'},{confirmed:true}),error=>error.code==='agent_identity_required');
 await assert.rejects(browser.runtime.participationEvent(taskId,crypto.randomUUID(),{kind:'confirm',expectedParticipationVersion:1,scopeVersion:1},{confirmed:true}),error=>error.code==='agent_identity_required');
 assert.equal(x.calls.filter(row=>row.path==='/v1/consents').length,before);assert.equal(await browser.runtime.getLocal('task-publication'),undefined);assert.equal(await browser.runtime.getLocal('task-event:'+taskId),undefined);
 assert.deepEqual(await browser.runtime.getLocal('task-draft'),{title:'Preserve my independent local draft',unknownLegacy:'retained'});assert.deepEqual((await browser.runtime.status()).identity,identity);
 await browser.runtime.putLocal('agent-continuity:'+identity.deviceId,{verified:true,agent:true,subjectId:identity.subjectId});
 await assert.rejects(browser.runtime.publishTask(draft(x.f),{confirmed:true}),error=>error.code==='agent_identity_evidence_invalid');
 // Ordinary community operations still reach their own server Account policy;
 // the Task Agent-continuity gate does not replace that independent requirement.
 await assert.rejects(browser.runtime.chat.create({title:'Synthetic ordinary community chat remains independent'},{confirmed:true}),error=>error.code==='account_verification_required');
 assert.ok(x.calls.some(row=>row.path==='/v2/chat/rooms/create'&&row.method==='POST'));
});

test('lost identity ACK reopens the same operation, then expired transfer proof and later control heads retain valid Task continuity',async t=>{
 const x=await fixture(t),browser=await x.web(),request=await x.offer(browser);x.drop.identity=true;
 await assert.rejects(browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true}),/ACK lost/);
 assert.equal((await browser.runtime.status()).identity,null);assert.equal((await browser.runtime.deviceHandoff.pending()).operationId,request.offer.operationId);
 browser.runtime.close();const reopened=await x.web(browser.store),joined=await reopened.runtime.deviceHandoff.reconcile(request.offer.operationId);assert.equal(joined.activated,true);
 await reopened.runtime.agentContinuity.retainReceipt(joined.receipt);await reopened.runtime.connect({confirmed:true});
 const initial=await reopened.runtime.agentContinuity.requireCurrent();assert.equal(initial.operationId,request.offer.operationId);assert.equal(initial.subjectId,x.genesis.id);
 const other=await x.authorizeOther();x.advance(181);reopened.runtime.close();const again=await x.web(browser.store);await again.runtime.connect({confirmed:true});
 const later=await again.runtime.agentContinuity.requireCurrent();assert.equal(later.deviceId,request.offer.deviceId);assert.notEqual(later.chainHead,initial.chainHead);assert.equal(later.serverPermissionsGranted,false);
 const count=Number((await x.f.db.query('SELECT count(*) FROM task_requests')).rows[0].count);x.drop.taskBefore=true;await assert.rejects(again.runtime.publishTask(draft(x.f),{confirmed:true}),/before delivery/);
 const saved=await again.runtime.getLocal('task-publication');assert.equal(Number((await x.f.db.query('SELECT count(*) FROM task_requests')).rows[0].count),count);
 const done=await again.runtime.reconcilePublication({retry:true});assert.equal(done.taskId,saved.payload.taskId);assert.equal(done.eventId,saved.payload.operationId);assert.equal(Number((await x.f.db.query('SELECT count(*) FROM task_requests')).rows[0].count),count+1);
 const posts=x.calls.filter(row=>row.path==='/v2/tasks').slice(-2);assert.equal(posts[0].body,posts[1].body);
 await x.revoke(x.native,x.native.deviceId);const withoutOriginalNative=await again.runtime.agentContinuity.requireCurrent();assert.equal(withoutOriginalNative.deviceId,request.offer.deviceId);
 await x.revoke(other,request.offer.deviceId);await assert.rejects(again.runtime.agentContinuity.requireCurrent(),error=>error.code==='agent_identity_device_not_current');
 const after=x.calls.filter(row=>row.path==='/v1/consents').length;await assert.rejects(again.runtime.publishTask(draft(x.f),{confirmed:true}));assert.equal(x.calls.filter(row=>row.path==='/v1/consents').length,after);
});

test('a delayed browser handoff cannot overwrite the identity selected by another runtime sharing its local store',async t=>{
  const x=await fixture(t),shared=memoryStore(),stale=await x.web(shared),request=await x.offer(stale);
 await stale.runtime.putLocal('task-draft',{title:'Original unsent browser draft'});
  const other=await x.web(shared,{initialize:true});
 const selected=(await other.runtime.status()).identity,activeKey=`galaxy-web:${x.config.endpoint}:active`,before=await shared.get(activeKey);
 assert.notEqual(selected.subjectId,x.genesis.id);
 await assert.rejects(stale.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true}),error=>error.code==='device_handoff_owner_changed');
 assert.deepEqual(await shared.get(activeKey),before);
 assert.deepEqual((await other.runtime.status()).identity,selected);
 assert.equal((await stale.runtime.status()).identity,null);
 assert.equal((await stale.runtime.getLocal('task-draft')).title,'Original unsent browser draft');
 const pending=await stale.runtime.deviceHandoff.pending();assert.equal(pending.operationId,request.offer.operationId);assert.equal(pending.state,'awaiting-result');
 assert.ok(await shared.get(`device:${x.genesis.id}:${request.offer.deviceId}`));
 assert.ok(await shared.get(`device:${selected.subjectId}:${selected.deviceId}`));
 const writes=x.calls.filter(row=>row.path==='/v2/identity/control/commit'&&JSON.parse(row.body).operationId===request.offer.operationId);
 assert.equal(writes.length,1);
 const current=await x.f.identityControl.publicState(x.genesis.id);
 assert.equal(current.devices.filter(row=>row.device_id===request.offer.deviceId&&row.status==='active').length,1);
 const reopened=await x.web(shared);assert.deepEqual((await reopened.runtime.status()).identity,selected);
 await assert.rejects(reopened.runtime.deviceHandoff.pending(),error=>error.code==='device_identity_switch_required');
});

test('existing-device proof binds exact web key; historical signatures survive native revocation but tampering never becomes current proof',async t=>{
 const x=await fixture(t),browser=await x.web(),request=await x.offer(browser),joined=await browser.runtime.deviceHandoff.acceptApproval(request.approval,{confirmed:true});await browser.runtime.agentContinuity.retainReceipt(joined.receipt);await browser.runtime.connect({confirmed:true});
 const descriptor={subjectId:x.genesis.id,deviceId:request.offer.deviceId,keyId:await identityKeyId(request.offer.publicKeyPem)},signed=await x.signedContext({existingDevice:descriptor});
 await browser.runtime.agentContinuity.retainHandoff({...signed,offer:null,approval:null});assert.equal((await browser.runtime.agentContinuity.requireCurrent()).operationId,null);
 const key='agent-continuity:'+descriptor.deviceId,saved=await browser.runtime.getLocal(key);
 const changed=structuredClone(saved);changed.context.existingDevice.deviceId=crypto.randomUUID();await browser.runtime.putLocal(key,changed);await assert.rejects(browser.runtime.agentContinuity.requireCurrent(),error=>error.code==='agent_identity_evidence_invalid');await browser.runtime.putLocal(key,saved);
 await x.authorizeOther();await x.revoke(x.native,x.native.deviceId);x.advance(181);browser.runtime.close();const reopened=await x.web(browser.store);await reopened.runtime.connect({confirmed:true});
 assert.equal((await reopened.runtime.agentContinuity.requireCurrent()).deviceId,descriptor.deviceId);
 x.drop.taskAfter=true;await assert.rejects(reopened.runtime.publishTask(draft(x.f),{confirmed:true}),/ACK lost/);const pending=await reopened.runtime.getLocal('task-publication'),writes=x.calls.filter(row=>row.path==='/v2/tasks').length;
 const receipt=await reopened.runtime.reconcilePublication({retry:true});assert.equal(receipt.state,'acknowledged');assert.equal(receipt.taskId,pending.payload.taskId);assert.equal(x.calls.filter(row=>row.path==='/v2/tasks').length,writes);
});
