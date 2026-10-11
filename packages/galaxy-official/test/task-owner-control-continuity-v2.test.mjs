import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createRecoveryMaterial,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {TaskOwnerControlServiceV2} from '../src/task-owner-control-v2.mjs';
import {digest} from '../src/shared/digest.mjs';
import {createRetirementController} from '../src/retirement.mjs';

// Actual HTTP, PGlite, device recovery and signed Consent. Device storage is a
// Map contract fixture, not physical browser/IDB; community quotas are isolated
// by serviceFixture, not evidence of public Account verification.
async function fixture({retiring=false}={}){
 const now=Math.floor(Date.now()/1000);let phaseNow=now,dropAck=false;
 const retirement=retiring?createRetirementController({version:1,id:'task-owner-control-test',endpoint:'https://official.example.org',
  operator:'Synthetic fixture',reason:'Explicit recovered original work control',announcedAt:now+1,stopWritesAt:now+2,
  takeoutUntil:now+3,statusUntil:now+4,contactUrl:'https://official.example.org/contact',deletionPolicyUrl:'https://official.example.org/deletion'},
 {endpoint:'https://official.example.org',now:()=>phaseNow}):undefined;
 const f=await serviceFixture(browserScopes,null,{now,retirement}),values=new Map(),peers=[];
 f.taskOwnerControl??=new TaskOwnerControlServiceV2(f.access,f.consents,{tasks:f.assistance,ownerRead:f.taskOwnerRead});
 const api=createApi({...f,rateLimit:1000});let runtime;
 const get=async key=>structuredClone(values.get(key)),put=async(key,value)=>values.set(key,structuredClone(value));
 const store={get,put,async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);return structuredClone(committed);},async prepareRecovery(subjectId,operationId){const key=`pending-recovery:${subjectId}:${operationId}`;
  let value=await get(key);if(!value){value={...await createRecoveryMaterial(subjectId),operationId};await put(key,value);}return value;},
  async declareSaved(subjectId,id){const key=`pending-recovery:${subjectId}:${id}`;await put(key,{...await get(key),saveDeclared:true});},
  async recordReceipt(subjectId,id,receipt){const key=`pending-recovery:${subjectId}:${id}`;await put(key,{...await get(key),receipt});}};
 try{
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
  runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,fetch:async(url,options)=>{
   const path=new URL(url).pathname,response=await fetch(origin+path,options);
   if(dropAck&&path.endsWith('/owner-control')&&response.ok){dropAck=false;await response.text();throw new Error('synthetic_committed_ack_lost');}return response;}});
  await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
  const recovery=await runtime.prepareRecovery();await runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
  const sign=async(payloadJson,action,objectId,{expiresAt=f.now+7200,purpose,fields,...rest}={})=>{
   let prepared=await runtime.api.prepareAuthorization(payloadJson,{action,objectId,visibility:'Private',viewers:[],expiresAt,confirmed:true,...rest});
   if(purpose!==undefined||fields!==undefined){
    const owner=(await runtime.status()).identity,device=await get(`device:${owner.subjectId}:${owner.deviceId}`);
    const intent={...prepared.intent,...(purpose===undefined?{}:{purpose}),...(fields===undefined?{}:{fields})};
    prepared={...prepared,intent,signedIntent:await signIdentityPayload(JSON.stringify(intent),device.privateKey,{type:'galaxy-consent+jws'})};
   }
   return runtime.api.submitAuthorization(prepared,{confirmed:true});
  };
  const publish=async({caseId=null,viewers=[],expiresAt=f.now+7200}={})=>{const task={operationId:randomUUID(),taskId:randomUUID(),caseId,
   intent:'proactive-review',title:'Synthetic original work control',summary:'Private original work must remain exact',
   workContext:{goal:'Keep original facts',currentSituation:'Explicit same-ID recovery',attemptRefs:[]},visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+10000};
   const request=await sign(JSON.stringify(task),'assistance.publish',task.operationId,{viewers,expiresAt});await runtime.api.call('/v2/tasks',request);return {...task,request};};
  const recover=async()=>{const before=(await runtime.status()).identity;const recoveredMaterial=await runtime.recover(recovery.code,{confirmed:true});
   await runtime.confirmRecoveredCode({operationId:recoveredMaterial.operationId,confirmed:true});await runtime.connect({confirmed:true});const after=(await runtime.status()).identity;
   assert.equal(after.subjectId,before.subjectId);assert.notEqual(after.deviceId,before.deviceId);};
  const preview=(task,kind='cancel',operationId=randomUUID())=>runtime.api.call(`/v2/tasks/${task.taskId}/owner-control/prepare`,
   {operationId,kind,reason:'Explicit synthetic original Task control'});
  const permit=p=>sign(p.payloadJson,p.authorization.action,p.operationId,{expiresAt:p.expiresAt});
  const execute=(task,request)=>runtime.api.call(`/v2/tasks/${task.taskId}/owner-control`,request);
  const receipt=(task,p)=>runtime.api.call('/v2/tasks/receipt',{taskId:task.taskId,eventId:p.operationId,payloadHash:p.payloadHash});
  const original=task=>f.db.query('SELECT id,subject_id,payload_text,payload_hash,consent_id,version FROM task_events WHERE task_id=$1 ORDER BY version',[task.taskId]).then(r=>r.rows);
  const peer=async()=>{const data=new Map(),r=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{
   store:{get:async key=>structuredClone(data.get(key)),put:async(key,v)=>data.set(key,structuredClone(v))},now:()=>f.now,
   fetch:(url,options)=>fetch(origin+new URL(url).pathname,options)});peers.push(r);await r.createIdentity({confirmed:true});await r.connect({confirmed:true});return r;};
  const raw=async(path,body,credential)=>{const r=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',
   ...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  const revokeDevice=async()=>{const owner=(await runtime.status()).identity,state=await runtime.publicControl(owner.subjectId),device=state.devices.find(d=>d.device_id===owner.deviceId);
   const material=await get(`device:${owner.subjectId}:${owner.deviceId}`),challenge=await runtime.api.call('/v2/identity/control/challenges',
    {version:2,operationId:randomUUID(),subjectId:owner.subjectId,kind:'revoke-device',expectedEpoch:state.epoch,previousEventHash:state.chainHead,
     signerKeyId:device.key_id,deviceId:owner.deviceId},{authenticated:false});
   await runtime.api.call('/v2/identity/control/commit',{operationId:challenge.operationId,controllerSignature:await signIdentityPayload(challenge.challenge,material.privateKey)},{authenticated:false});};
  return{f,runtime,sign,publish,recover,preview,permit,execute,receipt,original,peer,raw,revokeDevice,retire:offset=>{phaseNow=now+offset;},loseNextAck:()=>{dropAck=true;},
   close:async()=>{runtime.close();peers.forEach(p=>p.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
 }catch(error){runtime?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();throw error;}
}
const code=value=>error=>error.code===value;

test('recovered owner separately confirms cancel and close without changing original facts or counterpart participation',async()=>{
 for(const kind of ['cancel','close']){
  const h=await fixture();
  try{const {f,runtime}=h,other=await serviceFixture(browserScopes,f.db,{migrateDatabase:false,now:f.now});
   const task=await h.publish({viewers:[other.actor.subjectId]}),owner=(await runtime.status()).identity.subjectId;
   const proposal={kind:'propose',eventId:randomUUID(),expectedTaskVersion:1,participationId:randomUUID(),subjectId:other.actor.subjectId,
    role:'advice',scopeVersion:1,agreedScope:'Synthetic mutually agreed original work'};
   await runtime.api.call(`/v2/tasks/${task.taskId}/participations`,await h.sign(JSON.stringify(proposal),'assistance.publish',proposal.eventId,{viewers:[other.actor.subjectId]}));
   const confirmation={kind:'confirm',eventId:randomUUID(),expectedParticipationVersion:1,scopeVersion:1};
   await f.assistance.submitParticipationEvent(other.actor,proposal.participationId,await other.authorize(confirmation,'assistance.publish',
    {objectId:confirmation.eventId,viewers:[owner]}));
   const retained=await h.original(task),participations=(await f.db.query('SELECT * FROM task_participations WHERE task_id=$1',[task.taskId])).rows;
   await h.recover();await assert.rejects(runtime.api.call(`/v2/tasks/${task.taskId}`,{},{method:'GET'}),code('consent_required'));
   const reading=await runtime.api.call(`/v2/tasks/${task.taskId}/owner-read/prepare`,{operationId:randomUUID()});
   const readPermit=await h.sign(reading.payloadJson,'task.owner-read',JSON.parse(reading.payloadJson).operationId,{expiresAt:reading.expiresAt});
   const read=await runtime.api.call(`/v2/tasks/${task.taskId}/owner-read`,readPermit);assert.equal(read.taskWriteGranted,false);
   await assert.rejects(h.execute(task,readPermit),code('invalid_task_owner_control'));
   const p=await h.preview(task,kind),request=await h.permit(p);
   assert.equal(p.expectedTaskVersion,3);assert.equal(p.payloadHash,digest(p.payloadJson));assert.deepEqual(p.authorization.viewers,[]);
   assert.equal(JSON.stringify(p).includes(task.summary),false);assert.equal(p.historyRetained,true);
   const result=await h.execute(task,request);assert.equal(result.state,kind==='cancel'?'canceled':'closed');assert.equal(result.version,4);
   assert.equal(result.completeTaskAccessGranted,false);assert.equal(result.settlementExecuted,false);assert.equal(result.currentAccessGranted,false);
   assert.deepEqual((await h.original(task)).slice(0,-1),retained);assert.deepEqual((await f.db.query('SELECT * FROM task_participations WHERE task_id=$1',[task.taskId])).rows,participations);
   assert.equal((await h.original(task)).at(-1).payload_text,p.payloadJson);assert.equal((await h.receipt(task,p)).state,'acknowledged');
   assert.deepEqual(await h.execute(task,request),result,'same exact original operation replays without increment');
   await assert.rejects(h.preview(task,kind,p.operationId),code('task_owner_control_receipt_required'));
   await assert.rejects(runtime.api.call(`/v2/tasks/${task.taskId}`,{},{method:'GET'}),code('consent_required'));
  }finally{await h.close();}
 }
});

test('lost control ACK recovers only the original event hash after rebinding and original source withdrawal',async()=>{
 const h=await fixture();try{const task=await h.publish();await h.recover();const p=await h.preview(task),request=await h.permit(p);
  h.loseNextAck();await assert.rejects(h.execute(task,request));assert.equal((await h.original(task)).length,2);
  await h.runtime.connect({confirmed:true});await assert.rejects(h.execute(task,request),code('task_owner_control_scope_mismatch'));
  const receipt=await h.receipt(task,p);assert.equal(receipt.state,'acknowledged');assert.equal(receipt.version,2);assert.equal(JSON.stringify(receipt).includes('payloadJson'),false);
  const reauthorized=await h.sign(request.payloadJson,'assistance.publish',p.operationId,{expiresAt:p.expiresAt});
  await assert.rejects(h.execute(task,reauthorized),code('task_event_conflict'));
  await h.runtime.api.call(`/v1/consents/${task.request.consentId}/revoke`,{});
  assert.equal((await h.receipt(task,p)).state,'acknowledged');await assert.rejects(h.execute(task,reauthorized),code('task_owner_control_source_unavailable'));
  assert.equal((await h.original(task)).length,2);const foreign=await h.peer();
  await assert.rejects(foreign.api.call('/v2/tasks/receipt',{taskId:task.taskId,eventId:p.operationId,payloadHash:p.payloadHash}),code('not_found'));
  assert.equal((await h.receipt(task,{...p,payloadHash:'0'.repeat(64)})).state,'conflict');
 }finally{await h.close();}
});

test('absent original control can receive a fresh Consent for the same bytes but stale version and changed lease remain denied',async()=>{
 const h=await fixture();try{const task=await h.publish();await h.recover();const p=await h.preview(task),old=await h.permit(p);
  assert.equal((await h.receipt(task,p)).state,'absent');await h.runtime.connect({confirmed:true});
  await assert.rejects(h.execute(task,old),code('task_owner_control_scope_mismatch'));
  const fresh=await h.permit(p);assert.equal(fresh.payloadJson,old.payloadJson);
  const competitor=await h.preview(task,'close'),winner=await h.execute(task,await h.permit(competitor));assert.equal(winner.version,2);
  await assert.rejects(h.execute(task,fresh),code('task_version_conflict'));assert.equal((await h.receipt(task,p)).state,'absent');
  assert.equal((await h.original(task)).length,2);
 }finally{await h.close();}
 const h2=await fixture();try{const task=await h2.publish();await h2.recover();const p=await h2.preview(task),old=await h2.permit(p);
  await h2.runtime.connect({confirmed:true});assert.equal((await h2.receipt(task,p)).state,'absent');
  const fresh=await h2.permit(p);assert.equal(fresh.payloadJson,old.payloadJson);assert.equal((await h2.execute(task,fresh)).eventId,p.operationId);
 }finally{await h2.close();}
});

test('control requires a new exact owner-only current-binding Consent bounded by retained source expiry',async()=>{
 const h=await fixture();try{const task=await h.publish({expiresAt:h.f.now+120});await h.recover();const p=await h.preview(task),other=await h.peer();
  assert.equal(p.expiresAt,h.f.now+120);const wrongs=[{viewers:[(await other.status()).identity.subjectId]},{visibility:'Public'},{purpose:'public-profile'},
   {expiresAt:h.f.now+121},{fields:['taskId','event','extra']}];
  for(const options of wrongs){const bad=await h.sign(p.payloadJson,'assistance.publish',p.operationId,{expiresAt:p.expiresAt,...options});
   await assert.rejects(h.execute(task,bad),code('task_owner_control_scope_mismatch'));}
  const wrongAction=await h.sign(p.payloadJson,'task.owner-read',p.operationId,{expiresAt:p.expiresAt});await assert.rejects(h.execute(task,wrongAction),code('consent_required'));
  const broad=JSON.parse(p.payloadJson);broad.event={kind:'extend-enrollment',eventId:p.operationId,expectedTaskVersion:1,enrollmentExpiresAt:h.f.now+20000};
  await assert.rejects(h.execute(task,await h.sign(JSON.stringify(broad),'assistance.publish',p.operationId,{expiresAt:p.expiresAt})),code('invalid_task_owner_control'));
  const foreign=await other.api.call(`/v2/tasks/${task.taskId}/owner-control/prepare`,{operationId:randomUUID(),kind:'cancel',reason:'Synthetic foreign attempt'}).catch(error=>error);
  assert.equal(foreign.code,'not_found');const request=await h.permit(p);await h.runtime.api.call(`/v1/consents/${request.consentId}/revoke`,{});
  await assert.rejects(h.execute(task,request),code('consent_required'));assert.equal((await h.original(task)).length,1);
 }finally{await h.close();}
});

test('recover-only source proof never restores manual revocation, deleted content or expired original intent for control',async()=>{
 const h=await fixture();try{const manual=await h.publish(),binding=h.runtime.api.snapshot().bindingId;await h.runtime.connect({confirmed:true});
  await h.runtime.api.call(`/v1/bindings/${binding}/revoke`,{});const tasks={};for(const key of ['revoked','expired','erased','deleted','pending','valid'])tasks[key]=await h.publish();
  await h.recover();await assert.rejects(h.preview(manual),code('task_owner_control_source_unavailable'));
  for(const key of ['revoked','expired','erased','deleted']){const task=tasks[key],p=await h.preview(task),permit=await h.permit(p);
   if(key==='revoked')await h.runtime.api.call(`/v1/consents/${task.request.consentId}/revoke`,{});
   if(key==='expired')await h.f.db.query('UPDATE consents SET expires_at=$2 WHERE id=$1',[task.request.consentId,new Date((h.f.now-1)*1000).toISOString()]);
   if(key==='erased')await h.f.db.query("UPDATE task_events SET payload_text='' WHERE id=$1",[task.operationId]);
   if(key==='deleted')await h.f.db.query("UPDATE task_requests SET snapshot=snapshot||'{\"contentDeleted\":true}'::jsonb WHERE id=$1",[task.taskId]);
   await assert.rejects(h.execute(task,permit),code('task_owner_control_source_unavailable'));assert.equal((await h.original(task)).length,1);
  }
  const task=tasks.pending,p=await h.preview(task),permit=await h.permit(p),deletion=await h.runtime.privacy.submitDeletion(
   await h.runtime.privacy.prepareDeletion({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'}),{confirmed:true});
  await assert.rejects(h.execute(task,permit),code('task_owner_control_source_unavailable'));
  await h.runtime.privacy.submitDeletion(await h.runtime.privacy.prepareDeletion({action:'cancel',requestId:deletion.id,expectedRevision:deletion.revision}),{confirmed:true});
  assert.equal((await h.execute(task,permit)).state,'canceled');
  await h.f.db.query("UPDATE task_events SET payload_text='{}' WHERE id=$1",[tasks.valid.operationId]);const invalid=await h.preview(tasks.valid);
  await assert.rejects(h.execute(tasks.valid,await h.permit(invalid)),code('task_owner_control_integrity_error'));
 }finally{await h.close();}
 const h2=await fixture();try{const task=await h2.publish();await h2.revokeDevice();await h2.recover();
  await assert.rejects(h2.preview(task),code('task_owner_control_source_unavailable'));
 }finally{await h2.close();}
});

test('a paused Case permits original Task cancellation but not closing and a real Case withdrawal rejects both',async()=>{
 const h=await fixture();try{const {f,runtime}=h,reporter=await serviceFixture(browserScopes,f.db,{migrateDatabase:false,now:f.now}),
   moderator=await serviceFixture(browserScopes,f.db,{migrateDatabase:false,now:f.now}),owner=(await runtime.status()).identity.subjectId,caseId=randomUUID();
  const root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:owner,localRef:randomUUID(),
   title:'Synthetic original source for control',summary:'Source permission and pause remain distinct',source:{kind:'local',reference:randomUUID()},synthetic:true};
  await runtime.api.call('/v2/cases/events',await h.sign(JSON.stringify(root),'case.teaser.publish',caseId,{viewers:[reporter.actor.subjectId,moderator.actor.subjectId]}));
  const paused=await h.publish({caseId}),withdrawn=await h.publish({caseId});f.moderation.moderatorIds=[moderator.actor.subjectId];
  const report={id:randomUUID(),caseId,caseVersion:1,targetEventId:caseId,category:'other',summary:'Synthetic pause; no real allegation'};
  await f.moderation.report(reporter.actor,await reporter.authorize(report,'moderation.publish',{viewers:[moderator.actor.subjectId]}));
  const pause={id:randomUUID(),reportId:report.id,expectedVersion:1,kind:'pause',summary:'Explicit synthetic pause'};
  await f.moderation.event(moderator.actor,report.id,await moderator.authorize(pause,'moderation.publish',{viewers:[owner,reporter.actor.subjectId]}));
  await h.recover();await assert.rejects(h.preview(paused,'close'),code('task_paused'));
  const p=await h.preview(paused);assert.equal((await h.execute(paused,await h.permit(p))).state,'canceled');
  const unavailable=await h.preview(withdrawn),permit=await h.permit(unavailable),withdrawal={schemaVersion:2,kind:'case-withdrawn',eventId:randomUUID(),caseId,
   expectedVersion:1,actorId:owner,reason:'Explicit synthetic source withdrawal'};
  await runtime.api.call('/v2/cases/events',await h.sign(JSON.stringify(withdrawal),'case.teaser.publish',withdrawal.eventId));
  await assert.rejects(h.execute(withdrawn,permit),code('task_owner_control_source_unavailable'));
  await assert.rejects(h.preview(withdrawn,'close'),code('task_owner_control_source_unavailable'));
  assert.equal((await h.original(withdrawn)).length,1);
 }finally{await h.close();}
});

test('owner control HTTP rejects extra keys and anonymous calls and never permits writes during takeout or status-only',async()=>{
 const h=await fixture({retiring:true});try{const task=await h.publish();await h.recover();const p=await h.preview(task),request=await h.permit(p),path=`/v2/tasks/${task.taskId}/owner-control`;
  for(const extra of [{taskId:randomUUID()},{extra:true}])await assert.rejects(h.runtime.api.call(path+'/prepare',{operationId:randomUUID(),kind:'cancel',reason:'Synthetic strict control',...extra}),error=>error.status===400);
  await assert.rejects(h.runtime.api.call(path,{...request,taskId:randomUUID()}),error=>error.status===400);
  await assert.rejects(h.runtime.api.call(`/v2/tasks/${randomUUID()}/owner-control`,request),code('task_owner_control_scope_mismatch'));
  assert.equal((await h.raw(path+'/prepare',{operationId:randomUUID(),kind:'cancel',reason:'Synthetic anonymous control'})).status,401);
  const limited=await serviceFixture(['binding'],h.f.db,{migrateDatabase:false,now:h.f.now});
  assert.equal((await h.raw(path,request,limited.credential)).status,401);
  h.retire(2);assert.equal((await h.preview(task)).kind,'cancel');await assert.rejects(h.execute(task,request),code('service_writes_stopped'));
  h.retire(3);await assert.rejects(h.preview(task),code('service_retired'));await assert.rejects(h.execute(task,request),code('service_retired'));
  h.retire(4);await assert.rejects(h.execute(task,request),code('service_retired'));assert.equal((await h.original(task)).length,1);
 }finally{await h.close();}
});
