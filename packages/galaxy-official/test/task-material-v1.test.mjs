import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';
import {communityForumFixture}from'./community-forum-fixture.mjs';
import {digest}from'../src/shared/digest.mjs';
import {cleanupProductV2Retention}from'../src/operations/lifecycle-retention-v2.mjs';

import {materialTask} from './task-material-fixture.mjs';

test('real signed HTTP/OIDC: empty draft source satisfies all required fields and keeps original root body-free',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f,{independent:''});const written=await f.ok('/v2/tasks',{input:p.input});assert.equal(written.taskId,p.request.taskId);
  const view=await f.ok('/v2/tasks/'+p.request.taskId);assert.equal(view.request.title,p.post.title);assert.equal(view.request.summary,p.post.body);assert.equal(view.request.workContext.goal,p.post.title);
  assert.equal(JSON.stringify(view.rootRequest),p.input.payloadJson);assert.equal(view.textView.fields.title.state,'available');
  const publicView=await f.ok('/v2/tasks/'+p.request.taskId,{authorization:false});assert.equal(Object.hasOwn(publicView,'rootRequest'),false);assert.equal(Object.hasOwn(publicView.request,'materials'),false);
  const events=(await f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE task_id=$1',[p.request.taskId])).rows;
  assert.equal(events[0].payload_text,p.input.payloadJson);assert.equal(events[0].payload_hash,digest(p.input.payloadJson));assert.equal(events[0].payload_text.includes(p.post.body),false);
  assert.equal((await f.db.query('SELECT count(*) n FROM task_materials_v1 WHERE task_id=$1 AND body_text<>\'\'',[p.request.taskId])).rows[0].n,2);
 }finally{await f.close();}
});
test('source revoke: independent summary, Task fact and original receipt survive; public whole response and cleanup expose no old controlled body',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});await f.owner.consents.revoke(f.owner.actor,p.source.consentId);
  const current=await f.ok('/v2/tasks/'+p.request.taskId,{authorization:false});assert.equal(current.request.title,'');assert.equal(current.request.summary,p.independent);assert.equal(current.textView.fields.title.state,'unavailable');
  const serialized=JSON.stringify(current);for(const forbidden of [p.post.title,p.post.body,p.prepared.source.permissionId,p.prepared.source.payloadHash,p.request.materials[0].source.selectionHash])assert.equal(serialized.includes(forbidden),false,forbidden);
  assert.equal((await f.ok('/v2/tasks/receipt',{input:{taskId:p.request.taskId,eventId:p.request.operationId,payloadHash:digest(p.input.payloadJson)}})).state,'acknowledged');
  assert.equal((await f.ok('/v2/tasks',{input:p.input})).eventId,p.request.operationId);
  const result=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint});assert.equal(result.removed.taskMaterialBodiesErased,2);
  assert.equal((await f.db.query("SELECT count(*) n FROM task_materials_v1 WHERE task_id=$1 AND body_text<>''",[p.request.taskId])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT payload_text FROM task_events WHERE id=$1',[p.request.operationId])).rows[0].payload_text,p.input.payloadJson);
 }finally{await f.close();}
});
test('source-only expiry keeps root and identity current, returns independent segments and original receipt',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f,{expiry:30});await f.ok('/v2/tasks',{input:p.input});f.clock.now+=31;
  const view=await f.ok('/v2/tasks/'+p.request.taskId);assert.equal(view.request.title,'');assert.equal(view.request.summary,p.independent);assert.equal(view.rootRequest.operationId,p.request.operationId);
  assert.equal((await f.ok('/v2/tasks/receipt',{input:{taskId:p.request.taskId,eventId:p.request.operationId,payloadHash:digest(p.input.payloadJson)}})).state,'acknowledged');
  assert.equal((await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint})).removed.taskMaterialBodiesErased,2);
 }finally{await f.close();}
});
test('body tamper and foreign author reject atomically, no Consent/event/audit/storage growth',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);const counts=async()=>({consents:(await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,events:(await f.db.query('SELECT count(*) n FROM task_events')).rows[0].n,materials:(await f.db.query('SELECT count(*) n FROM task_materials_v1')).rows[0].n,audits:(await f.db.query('SELECT count(*) n FROM audit_events')).rows[0].n});
  const before=await counts();const bad={...p.input,materialBodies:p.input.materialBodies.map((b,i)=>i?b:{...b,text:'Changed detached text'})};
  assert.equal((await f.request('/v2/tasks',{input:bad})).status,409);assert.deepEqual(await counts(),before);
  assert.equal((await f.request('/v2/task-materials/prepare',{who:f.responder,input:{source:{postId:p.post.postId,versionId:p.post.versionId},selections:[{materialId:randomUUID(),field:'body',start:0,end:5}],expiresAt:p.post.publishedUntil}})).status,403);
  assert.deepEqual(await counts(),before);
  assert.equal((await f.request('/v1/consents',{input:{signedIntent:p.input.signedIntent}})).status,403);
  assert.deepEqual(await counts(),before);
 }finally{await f.close();}
});

test('legacy unknown cause hides without erasure; signed pending deletion cannot conceal an independently revoked source Consent',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f,{reconnectAfterSource:true});await f.ok('/v2/tasks',{input:p.input});
  // Controlled historical fixture only: an old binding already lacks cause
  // metadata. Publication, Account, new binding and all requests are genuine.
  const sourceBinding=(await f.db.query('SELECT binding_id FROM consents WHERE id=$1',[p.source.consentId])).rows[0].binding_id;
  assert.notEqual(sourceBinding,f.owner.actor.bindingId);
  await f.db.query('UPDATE bindings SET revoked_at=$2,revocation_kind=NULL,revocation_control_event_id=NULL,revocation_request_id=NULL WHERE id=$1',[sourceBinding,new Date(f.clock.now*1000).toISOString()]);
  const unknown=await f.ok('/v2/tasks/'+p.request.taskId+'/materials/status');assert(unknown.items.every(item=>item.permanent===false&&item.reasons.includes('historical-cause-unavailable')));
  assert.equal((await f.ok('/v2/tasks/'+p.request.taskId)).request.summary,p.independent);
  assert.equal((await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint})).removed.taskMaterialBodiesErased,0);
  assert.equal((await f.db.query("SELECT count(*) n FROM task_materials_v1 WHERE task_id=$1 AND body_text<>''",[p.request.taskId])).rows[0].n,2);
  const command={version:1,id:randomUUID(),endpoint:f.owner.access.endpoint,subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,
   issuedAt:f.clock.now,expiresAt:f.clock.now+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
  await f.owner.deletion.submit(f.owner.actor,await f.owner.signForTest(JSON.stringify(command),'galaxy-deletion-intent+jws'));
  await f.owner.consents.revoke(f.owner.actor,p.source.consentId);
  const state=await f.owner.assistance.taskMaterials.sourceWithin(f.db,p.request.materials[0].source,{ownerId:f.owner.actor.subjectId});
  assert.equal(state.permanent,true);assert(state.reasons.includes('consent-revoked'));assert(state.reasons.includes('deletion-pending'));
  assert.equal((await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint})).removed.taskMaterialBodiesErased,2);
  assert.equal((await f.db.query("SELECT count(*) n FROM task_materials_v1 WHERE task_id=$1 AND body_text<>''",[p.request.taskId])).rows[0].n,0);
 }finally{await f.close();}
});
