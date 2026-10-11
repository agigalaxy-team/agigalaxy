import test from'node:test';import assert from'node:assert/strict';import {randomUUID}from'node:crypto';
import {communityForumFixture}from'./community-forum-fixture.mjs';import {materialTask}from'./task-material-fixture.mjs';
import {cleanupProductV2Retention}from'../src/operations/lifecycle-retention-v2.mjs';
import {approveFixtureDeletion}from'./deletion-execute-workflow.mjs';import {executeDeletion}from'../src/operations/deletion-execute.mjs';
import {digest} from '../src/shared/digest.mjs';

test('source current view changes only with visible semantic content, not reader check time; search/history stop matching withdrawn text',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});const search={type:'task',query:{query:'Selected source'}};
  const page=await f.owner.search.v2.query(f.owner.actor,search);assert.equal(page.items.length,1);assert.equal(page.items[0].textView.fields.title.state,'available');
  f.clock.now++;const current=await f.owner.search.v2.reference(f.owner.actor,{search,ref:page.items[0].ref});assert.equal(current.state,'current');
  const history=await f.owner.history.queryV2(f.owner.actor,{subjectId:f.owner.actor.subjectId,query:'Selected source',timeWindow:{kind:'all-visible'}});assert(history.items.some(i=>i.taskId===p.request.taskId));
  await f.owner.consents.revoke(f.owner.actor,p.source.consentId);
  assert.equal((await f.owner.search.v2.query(f.owner.actor,search)).items.length,0);
  assert.equal((await f.owner.history.queryV2(f.owner.actor,{subjectId:f.owner.actor.subjectId,query:'Selected source',timeWindow:{kind:'all-visible'}})).items.length,0);
  const retained=await f.owner.history.queryV2(f.owner.actor,{subjectId:f.owner.actor.subjectId,query:p.independent.trim(),timeWindow:{kind:'all-visible'}});assert(retained.items.some(i=>i.taskId===p.request.taskId));
 }finally{await f.close();}
});

test('signed pending deletion hides managed text without erasing; cancellation restores it; approved execution actually removes owned sidecars',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});const base={version:1,endpoint:f.owner.access.endpoint,subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,issuedAt:f.clock.now,expiresAt:f.clock.now+300};
  const pending=await f.owner.deletion.submit(f.owner.actor,await f.owner.signForTest(JSON.stringify({...base,id:randomUUID(),action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'}),'galaxy-deletion-intent+jws'));
  const hidden=await f.ok('/v2/tasks/'+p.request.taskId);assert.equal(hidden.request.title,'');assert.equal(hidden.request.summary,p.independent);
  assert.equal((await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint})).removed.taskMaterialBodiesErased,0);
  await f.owner.deletion.submit(f.owner.actor,await f.owner.signForTest(JSON.stringify({...base,id:randomUUID(),action:'cancel',requestId:pending.id,expectedRevision:1}),'galaxy-deletion-intent+jws'));
  assert.equal((await f.ok('/v2/tasks/'+p.request.taskId)).request.title,p.post.title);
  f.owner.now=f.clock.now;const command=await approveFixtureDeletion(f.owner,f.db);const result=await executeDeletion(f.db,command,{now:()=>f.clock.now});
  assert.equal((await f.db.query('SELECT count(*) n FROM task_materials_v1 WHERE subject_id=$1',[f.owner.actor.subjectId])).rows[0].n,0);assert.equal(result.deletedCounts.task_materials_v1,2);
 }finally{await f.close();}
});

test('later enrollment and real Case link keep the exact original root; Case withdrawal erases only controlled sidecars and preserves receipt',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});
  const extension={taskId:p.request.taskId,event:{eventId:randomUUID(),expectedTaskVersion:1,kind:'extend-enrollment',enrollmentExpiresAt:f.clock.now+7200}};
  const extended=await f.owner.authorize(extension,'assistance.publish',{objectId:extension.event.eventId});
  await f.ok('/v2/tasks/'+p.request.taskId+'/events',{input:extended});
  const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,
   actorId:f.owner.actor.subjectId,taskId:p.request.taskId,localRef:randomUUID(),title:'Task '+p.request.taskId,
   summary:'Explicit synthetic scope-clarification fixture; no selected source copied into Case.',
   source:{kind:'active-task',reference:p.request.taskId},synthetic:true};
  const first={schemaVersion:2,kind:'intervention',eventId:randomUUID(),caseId,taskId:p.request.taskId,
   actorId:f.owner.actor.subjectId,expectedVersion:1,types:['scope-clarification'],affectsAttemptIds:[],
   description:'Explicit local fixture work scope',sourceRefs:[],observedEffect:'Clarified the test scope'};
  const authorizeFact=value=>f.owner.authorize(value,'case.teaser.publish',{objectId:value.eventId});
  await f.ok('/v2/tasks/'+p.request.taskId+'/case',{input:{operationId:randomUUID(),taskId:p.request.taskId,expectedTaskVersion:2,
   case:await authorizeFact(root),initialFact:await authorizeFact(first)}});
  const current=await f.ok('/v2/tasks/'+p.request.taskId);
  assert.equal(current.request.enrollmentExpiresAt,extension.event.enrollmentExpiresAt);assert.equal(current.request.caseId,caseId);
  assert.deepEqual(current.rootRequest,p.request);assert.equal(current.rootRequest.caseId,null);
  assert.equal(current.rootCommitment.payloadHash,digest(p.input.payloadJson));
  assert.equal((await f.db.query('SELECT payload_text FROM task_events WHERE id=$1',[p.request.operationId])).rows[0].payload_text,p.input.payloadJson);
  const withdrawal={schemaVersion:2,kind:'case-withdrawn',eventId:randomUUID(),caseId,taskId:p.request.taskId,
   actorId:f.owner.actor.subjectId,expectedVersion:2,reason:'Explicit fixture Case withdrawal'};
  await f.ok('/v2/cases/events',{input:await authorizeFact(withdrawal)});
  const inaccessible=await f.request('/v2/tasks/'+p.request.taskId);assert.equal(inaccessible.status,403);assert.equal(inaccessible.body.error,'task_case_unavailable');
  const cleaned=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint});
  assert.equal(cleaned.removed.taskMaterialBodiesErased,2);
  assert.equal((await f.db.query("SELECT count(*) n FROM task_materials_v1 WHERE body_text<>''")).rows[0].n,0);
  const receipt=await f.ok('/v2/tasks/receipt',{input:{taskId:p.request.taskId,eventId:p.request.operationId,payloadHash:digest(p.input.payloadJson)}});
  assert.equal(receipt.state,'acknowledged');assert.equal(receipt.version,1);
  assert.equal((await f.db.query('SELECT payload_text FROM task_events WHERE id=$1',[p.request.operationId])).rows[0].payload_text,p.input.payloadJson);
 }finally{await f.close();}
});
