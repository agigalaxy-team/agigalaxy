import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createNativeRecoveryWebFixture} from './native-recovery-web-fixture.mjs';
import {TaskOwnerReadServiceV2} from "../src/tasks/v2/owner-read-v2.mjs";
import {digest} from '../src/shared/digest.mjs';
import {createRetirementController} from "../src/privacy/retirement.mjs";

// Actual HTTP, PGlite, Binding, device control and JWS. A test-only Native
// signer supplies recovery/revocation and the real Web handoff; the consumer
// under test is production owner-read, not the retired Web recovery coordinator.
// The Web store is a Map contract, not physical-browser/IDB evidence.
async function fixture({retiring=false}={}) {
  const now=Math.floor(Date.now()/1000);let retirementNow=now;
  const retirement=retiring?createRetirementController({version:1,id:'owner-read-test',endpoint:'https://official.example.org',operator:'Synthetic fixture',
    reason:'Explicit recovered owner read',announcedAt:now+1,stopWritesAt:now+2,takeoutUntil:now+3,statusUntil:now+4,
    contactUrl:'https://official.example.org/contact',deletionPolicyUrl:'https://official.example.org/deletion'},
  {endpoint:'https://official.example.org',now:()=>retirementNow}):undefined;
  const f=await serviceFixture(browserScopes,null,{now,retirement});
  f.taskOwnerRead??=new TaskOwnerReadServiceV2(f.access,f.consents);
  const api=createApi({...f,rateLimit:1000}),values=new Map(),peers=[];let runtime;
  const get=async k=>structuredClone(values.get(k)),put=async(k,v)=>values.set(k,structuredClone(v));
  const store={get,put,async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);return structuredClone(committed);}};
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    runtime=await createNativeRecoveryWebFixture({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{store,now:()=>f.now,
      fetch:(url,options)=>fetch(origin+new URL(url).pathname,options)});
    await runtime.connect({confirmed:true});
    const recovery=await runtime.prepareRecovery();await runtime.saveRecovery({operationId:recovery.operationId,confirmed:true});
    const sign=async(payloadJson,action,objectId,{viewers=[],expiresAt=f.now+7200,...rest}={})=>{
      const prepared=await runtime.api.prepareAuthorization(payloadJson,{action,objectId,visibility:'Private',viewers,expiresAt,confirmed:true,...rest});
      return runtime.api.submitAuthorization(prepared,{confirmed:true});
    };
    const publish=async({viewers=[],expiresAt=f.now+7200,caseId=null}={})=>{
      const payload={operationId:randomUUID(),taskId:randomUUID(),caseId,intent:'proactive-review',title:'Synthetic retained owner work',
        summary:'Private original work remains exact',workContext:{goal:'Continue original work',currentSituation:'Synthetic device recovery test',attemptRefs:[]},
        visibility:'Private',collaboration:'open-assistance',enrollmentExpiresAt:f.now+10000};
      const request=await sign(JSON.stringify(payload),'assistance.publish',payload.operationId,{viewers,expiresAt});
      await runtime.api.call('/v2/tasks',request);return {...payload,request};
    };
    const recover=async()=>{const before=await runtime.status();const recoveredMaterial=await runtime.recover(recovery.code,{confirmed:true});
      await runtime.confirmRecoveredCode({operationId:recoveredMaterial.operationId,confirmed:true});await runtime.connect({confirmed:true});
      const after=await runtime.status();assert.equal(before.identity.subjectId,after.identity.subjectId);
      assert.notEqual(before.identity.deviceId,after.identity.deviceId);};
    const preview=(task,eventIds)=>runtime.api.call(`/v2/tasks/${task.taskId}/owner-read/prepare`,{operationId:randomUUID(),...(eventIds?{eventIds}:{})});
    const permit=async p=>sign(p.payloadJson,'task.owner-read',JSON.parse(p.payloadJson).operationId,{expiresAt:p.expiresAt});
    const read=(task,request)=>runtime.api.call(`/v2/tasks/${task.taskId}/owner-read`,request);
    const peer=async()=>{const data=new Map(),r=await createNativeRecoveryWebFixture({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{
      store:{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),update:memoryAtomicUpdate(data)},now:()=>f.now,
      fetch:(url,options)=>fetch(origin+new URL(url).pathname,options)});peers.push(r);
      await r.connect({confirmed:true});return r;};
    const raw=async(path,input,credential)=>{const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',
      ...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
    const revokeDevice=()=>runtime.revokeSelectedWebDevice({confirmed:true});
    return {f,runtime,sign,publish,recover,preview,permit,read,peer,raw,revokeDevice,retirePhase:offset=>{retirementNow=now+offset;},
      close:async()=>{runtime.close();for(const p of peers)p.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
  }catch(error){runtime?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();throw error;}
}
const code = expected => error=>error.code===expected;

test('explicit device revocation before same-clock recovery is never treated as recovery-only loss of Task permission',async()=>{
  const h=await fixture();
  try{const task=await h.publish();await h.revokeDevice();await h.recover();
    await assert.rejects(h.preview(task),code('task_owner_read_source_unavailable'));
  }finally{await h.close();}
});

test('recovered same-ID device explicitly reads exact authored Task events without restoring shared access or a complete snapshot',async()=>{
  const h=await fixture();const {f,runtime}=h;
  try{
    const other=await serviceFixture(browserScopes,f.db,{migrateDatabase:false,now:f.now});
    const task=await h.publish({viewers:[other.actor.subjectId]});
    const invite={taskId:task.taskId,event:{kind:'invite',eventId:randomUUID(),expectedTaskVersion:1,recipientId:other.actor.subjectId,note:'Synthetic invitation',expiresAt:f.now+600}};
    const request=await h.sign(JSON.stringify(invite),'assistance.publish',invite.event.eventId,{viewers:[other.actor.subjectId]});
    await runtime.api.call(`/v2/tasks/${task.taskId}/events`,request);
    const reply={taskId:task.taskId,event:{kind:'invitation-reply',eventId:randomUUID(),expectedTaskVersion:2,invitationId:invite.event.eventId,
      response:'interested',message:'Private counterpart response must stay withheld'}};
    await f.assistance.submitTaskEvent(other.actor,task.taskId,await other.authorize(reply,'assistance.publish',{
      objectId:reply.event.eventId,viewers:[(await runtime.status()).identity.subjectId]}));
    const original=await f.db.query('SELECT id,payload_text,payload_hash,consent_id,version FROM task_events WHERE task_id=$1 ORDER BY version',[task.taskId]);
    const oldConsent=(await f.db.query('SELECT * FROM consents WHERE id=$1',[task.request.consentId])).rows[0];
    await assert.rejects(h.preview(task),code('task_owner_read_source_unavailable'),'active old device does not use the recovery exception');
    await h.recover();
    await assert.rejects(runtime.api.call(`/v2/tasks/${task.taskId}`,{}, {method:'GET'}),code('consent_required'));
    await assert.rejects(f.assistance.getTask(other.actor,task.taskId),code('consent_required'));
    const p=await h.preview(task,[invite.event.eventId]);
    assert.equal(p.latestTaskVersion,3);assert.equal(p.events.length,2);assert.equal(p.completeTaskSnapshot,false);
    assert.equal(JSON.stringify(p).includes(task.summary),false);assert.equal(JSON.stringify(p).includes(reply.event.message),false);
    assert.equal(p.payloadHash,digest(p.payloadJson));assert.equal(p.expiresAt,f.now+3600);
    const permit=await h.permit(p),result=await h.read(task,permit);
    assert.deepEqual(result.events.map(e=>e.eventId),[task.operationId,invite.event.eventId]);
    assert.equal(result.events[0].payloadJson,task.request.payloadJson);assert.equal(result.events[1].payloadJson,request.payloadJson);
    assert.equal(result.events[0].payloadHash,digest(task.request.payloadJson));
    for(const flag of ['completeTaskSnapshot','contextAccessGranted','referenceAccessGranted','taskWriteGranted'])assert.equal(result[flag],false);
    assert.equal(Object.hasOwn(result,'request'),false);assert.equal(Object.hasOwn(result,'state'),false);
    assert.equal(JSON.stringify(result).includes(reply.event.message),false);
    assert.deepEqual((await f.db.query('SELECT id,payload_text,payload_hash,consent_id,version FROM task_events WHERE task_id=$1 ORDER BY version',[task.taskId])).rows,original.rows);
    assert.deepEqual((await f.db.query('SELECT * FROM consents WHERE id=$1',[task.request.consentId])).rows[0],oldConsent);
    await assert.rejects(h.preview(task,[reply.event.eventId]),code('not_found'));
    const foreign=await h.peer();
    await assert.rejects(foreign.api.call(`/v2/tasks/${task.taskId}/owner-read/prepare`,{operationId:randomUUID()}),code('not_found'));
    const cancel={taskId:task.taskId,event:{kind:'cancel',eventId:randomUUID(),expectedTaskVersion:3,reason:'Synthetic cancellation'}};
    await assert.rejects(runtime.api.call(`/v2/tasks/${task.taskId}/events`,await h.sign(JSON.stringify(cancel),'assistance.publish',cancel.event.eventId)),code('consent_required'));
    await runtime.api.call(`/v1/consents/${permit.consentId}/revoke`,{});
    await assert.rejects(h.read(task,permit),code('consent_required'));
  }finally{await h.close();}
});

test('owner read rejects withdrawn, expired, deleted and explicitly revoked original sources even at the recovery timestamp',async()=>{
  const h=await fixture();const {f,runtime}=h;
  try{
    const expiredBindingTask=await h.publish(),expiredBinding=runtime.api.snapshot().bindingId;
    await runtime.connect({confirmed:true});
    await f.db.query('UPDATE bindings SET expires_at=$2 WHERE id=$1',[expiredBinding,new Date((f.now-1)*1000).toISOString()]);
    const manual=await h.publish(),oldBinding=runtime.api.snapshot().bindingId;
    await runtime.connect({confirmed:true});
    await runtime.api.call(`/v1/bindings/${oldBinding}/revoke`,{});
    const tasks={};for(const kind of ['revoked','expired','erased','deleted','temporary','valid'])tasks[kind]=await h.publish();
    const revoked=tasks.revoked;await runtime.api.call(`/v1/consents/${revoked.request.consentId}/revoke`,{});
    const caseId=randomUUID(),owner=(await runtime.status()).identity.subjectId;
    const originalCase={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:owner,
      localRef:randomUUID(),title:'Synthetic withdrawn Case source',summary:'No data should be revived',source:{kind:'local',reference:randomUUID()},synthetic:true};
    await runtime.api.call('/v2/cases/events',await h.sign(JSON.stringify(originalCase),'case.teaser.publish',caseId));
    const withdrawnTask=await h.publish({caseId}),withdrawal={schemaVersion:2,kind:'case-withdrawn',eventId:randomUUID(),caseId,
      expectedVersion:1,actorId:owner,reason:'Synthetic source withdrawal'};
    await runtime.api.call('/v2/cases/events',await h.sign(JSON.stringify(withdrawal),'case.teaser.publish',withdrawal.eventId));
    // The accepted temporary event uses genuine signatures/API. Only aging its
    // stored timestamp below is a fixture for the existing 90-day boundary.
    const temp={taskId:tasks.temporary.taskId,event:{eventId:randomUUID(),expectedTaskVersion:1,kind:'suggest-contacts',state:'empty',items:[]}};
    const tempRequest=await h.sign(JSON.stringify(temp),'assistance.publish',temp.event.eventId);
    await runtime.api.call(`/v2/tasks/${tasks.temporary.taskId}/events`,tempRequest);
    await h.recover();
    const oldManual=(await f.db.query('SELECT revoked_at FROM bindings WHERE id=$1',[oldBinding])).rows[0];
    const recovered=(await f.db.query("SELECT accepted_at FROM subject_control_events WHERE subject_id=$1 AND kind='recover'",[(await runtime.status()).identity.subjectId])).rows[0];
    assert.equal(new Date(oldManual.revoked_at).getTime(),new Date(recovered.accepted_at).getTime(),'explicit clock coincidence must not classify manual revoke as recovery');
    await assert.rejects(h.preview(manual),code('task_owner_read_source_unavailable'));
    await assert.rejects(h.preview(expiredBindingTask),code('task_owner_read_source_unavailable'));
    await assert.rejects(h.preview(withdrawnTask),code('task_owner_read_source_unavailable'));
    await assert.rejects(h.preview(revoked),code('task_owner_read_source_unavailable'));
    await f.db.query('UPDATE consents SET expires_at=$2 WHERE id=$1',[tasks.expired.request.consentId,new Date((f.now-1)*1000).toISOString()]);
    await assert.rejects(h.preview(tasks.expired),code('task_owner_read_source_unavailable'));
    await f.db.query("UPDATE task_events SET payload_text='' WHERE id=$1",[tasks.erased.operationId]);
    await assert.rejects(h.preview(tasks.erased),code('task_owner_read_source_unavailable'));
    await f.db.query("UPDATE task_requests SET snapshot=snapshot||'{\"contentDeleted\":true}'::jsonb WHERE id=$1",[tasks.deleted.taskId]);
    await assert.rejects(h.preview(tasks.deleted),code('task_owner_read_source_unavailable'));
    await f.db.query('UPDATE task_events SET created_at=$2 WHERE id=$1',[temp.event.eventId,new Date((f.now-90*86400)*1000).toISOString()]);
    await assert.rejects(h.preview(tasks.temporary,[temp.event.eventId]),code('task_owner_read_source_unavailable'));
    assert.equal((await h.preview(tasks.temporary)).events.length,1,'expired child does not invalidate a retained unselected root');
    const foreign=await h.peer();
    await assert.rejects(foreign.api.call(`/v2/tasks/${tasks.valid.taskId}/owner-read/prepare`,{operationId:randomUUID()}),code('not_found'));
    await f.db.query('DELETE FROM task_events WHERE task_id=$1',[tasks.erased.taskId]);
    await f.db.query('DELETE FROM task_requests WHERE id=$1',[tasks.erased.taskId]);
    await assert.rejects(h.preview(tasks.erased),code('not_found'),'physical absence must not fabricate retained facts');
  }finally{await h.close();}
});

test('owner read HTTP is strict and authenticated, allows already-authorized takeout but not new Consent or status-only content',async()=>{
  const h=await fixture({retiring:true});const {f,runtime}=h;
  try{
    const task=await h.publish();await h.recover();const p=await h.preview(task),permit=await h.permit(p),path=`/v2/tasks/${task.taskId}/owner-read`;
    for(const body of [{operationId:randomUUID(),taskId:randomUUID()},{operationId:randomUUID(),extra:true}])
      await assert.rejects(runtime.api.call(path+'/prepare',body),code('invalid_task_owner_read'));
    await assert.rejects(runtime.api.call(path,{...permit,taskId:randomUUID()}),error=>error.status===400);
    await assert.rejects(runtime.api.call(`/v2/tasks/${randomUUID()}/owner-read`,permit),code('task_owner_read_scope_mismatch'));
    const anonymous=await h.raw(path+'/prepare',{operationId:randomUUID()});assert.equal(anonymous.status,401);
    const scoped=await serviceFixture(['binding'],f.db,{migrateDatabase:false,now:f.now});
    const denied=await h.raw(path+'/prepare',{operationId:randomUUID()},scoped.credential);assert.equal(denied.status,401);
    h.retirePhase(2);assert.equal((await h.preview(task)).events.length,1);
    assert.equal((await h.read(task,permit)).events[0].payloadJson,task.request.payloadJson);
    await assert.rejects(h.permit(await h.preview(task)),code('service_writes_stopped'));
    h.retirePhase(3);await assert.rejects(h.preview(task),code('service_retired'));await assert.rejects(h.read(task,permit),code('service_retired'));
    h.retirePhase(4);await assert.rejects(h.read(task,permit),code('service_retired'));
  }finally{await h.close();}
});

test('owner reading permit binds the current device, exact event versions, private audience and original expiry',async()=>{
  const h=await fixture();const {f,runtime}=h;
  try{
    const task=await h.publish({expiresAt:f.now+120}),other=await serviceFixture(browserScopes,f.db,{migrateDatabase:false,now:f.now});
    await h.recover();const p=await h.preview(task);
    assert.equal(p.expiresAt,f.now+120,'fresh reading cannot extend original intent expiry');
    const descriptor=JSON.parse(p.payloadJson),permit=await h.permit(p);
    const audience=await h.sign(p.payloadJson,'task.owner-read',descriptor.operationId,{viewers:[other.actor.subjectId],expiresAt:p.expiresAt});
    await assert.rejects(h.read(task,audience),code('task_owner_read_scope_mismatch'));
    const changed={...descriptor,eventRefs:descriptor.eventRefs.map(r=>({...r,payloadHash:'0'.repeat(64)}))};
    await assert.rejects(h.read(task,await h.sign(JSON.stringify(changed),'task.owner-read',descriptor.operationId,{expiresAt:p.expiresAt})),code('task_owner_read_preview_changed'));
    const excessive={...descriptor,expiresAt:f.now+121};
    await assert.rejects(h.read(task,await h.sign(JSON.stringify(excessive),'task.owner-read',descriptor.operationId,{expiresAt:excessive.expiresAt})),code('task_owner_read_preview_changed'));
    await f.db.query('UPDATE task_requests SET version=version+1 WHERE id=$1',[task.taskId]);
    await assert.rejects(h.read(task,permit),code('task_owner_read_preview_changed'));
    await f.db.query('UPDATE task_requests SET version=version-1 WHERE id=$1',[task.taskId]);
    await runtime.connect({confirmed:true});
    await assert.rejects(h.read(task,permit),code('task_owner_read_scope_mismatch'));
    const current=await h.preview(task),fresh=await h.permit(current);assert.equal((await h.read(task,fresh)).events.length,1);
    const deletion=await runtime.privacy.submitDeletion(await runtime.privacy.prepareDeletion({action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'}),{confirmed:true});
    await assert.rejects(h.preview(task),code('task_owner_read_source_unavailable'));
    await assert.rejects(h.read(task,fresh),code('task_owner_read_source_unavailable'));
    await runtime.privacy.submitDeletion(await runtime.privacy.prepareDeletion({action:'cancel',requestId:deletion.id,expectedRevision:deletion.revision}),{confirmed:true});
    assert.equal((await h.read(task,fresh)).events.length,1,'canceling an unexecuted deletion only restores otherwise still-valid reading');
    await runtime.api.call(`/v1/consents/${task.request.consentId}/revoke`,{});
    await assert.rejects(h.read(task,fresh),code('task_owner_read_source_unavailable'),'fresh Consent never revives an explicit original revocation');
  }finally{await h.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
