import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile}from'node:fs/promises';
import {communityForumFixture}from'./community-forum-fixture.mjs';import {materialTask}from'./task-material-fixture.mjs';
import {cleanupProductV2Retention}from'../src/operations/lifecycle-retention-v2.mjs';
import {subjectResourceUsage}from'../src/infrastructure/resource-budgets.mjs';
import {digest}from'../src/shared/digest.mjs';
import {taskMaterialSubmissionSchema}from'../src/shared/task-material-v1-schema.mjs';
import {taskRequestV2Schema}from'../src/shared/task-schema-v2.mjs';

test('exact selected current export and original event export recheck source on later pages, preserving independent Task root and note',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);await f.ok('/v2/tasks',{input:p.input});
  const ticket=await f.owner.dataExport.create(f.owner.actor,{id:randomUUID(),datasets:['authorized-views','task-materials','task-events'],views:[{kind:'task',id:p.request.taskId}]});
  const page=dataset=>f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset});
  assert.equal((await page('authorized-views')).items[0].view.request.title,p.post.title);
  assert((await page('task-materials')).items.every(row=>row.contentAvailable&&row.body_text));
  assert.equal((await page('task-events')).items[0].payload_text,p.input.payloadJson);
  await f.owner.consents.revoke(f.owner.actor,p.source.consentId);
  const selected=(await page('authorized-views')).items[0].view;assert.equal(selected.request.summary,p.independent);assert.equal(selected.request.title,'');
  const raw=await page('task-materials');assert(raw.items.every(row=>!row.contentAvailable&&row.body_text===''));
  assert.equal((await page('task-events')).items[0].payload_text,p.input.payloadJson);
  assert(!JSON.stringify(selected).includes(p.post.body));
 }finally{await f.close();}
});

test('same transaction budget includes sidecar, signed permission and audits, and rejects growth without leaving any grant or Task',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f,{edit:'漢'.repeat(3000)}),before=await subjectResourceUsage(f.db,f.owner.actor.subjectId,f.clock.now);
  const original=f.owner.access.resourceBudgetPolicy;f.owner.access.resourceBudgetPolicy={...original,maxPayloadBytesPerSubject:Number(before.payloadBytes)+8000};
  const counts=async()=>({consents:(await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,audits:(await f.db.query('SELECT count(*) n FROM audit_events')).rows[0].n});const existing=await counts();
  const rejected=await f.request('/v2/tasks',{input:p.input});assert.equal(rejected.status,409);assert.equal(rejected.body.error,'storage_quota_exceeded');
  assert.deepEqual(await counts(),existing);assert.equal((await subjectResourceUsage(f.db,f.owner.actor.subjectId,f.clock.now)).payloadBytes,before.payloadBytes);
  assert.equal((await f.db.query('SELECT count(*) n FROM task_materials_v1')).rows[0].n,0);
  f.owner.access.resourceBudgetPolicy=original;await f.ok('/v2/tasks',{input:p.input});
  const after=await subjectResourceUsage(f.db,f.owner.actor.subjectId,f.clock.now);
  const bytes=(await f.db.query(`SELECT (SELECT sum(octet_length(body_text)+octet_length(descriptor::text)+1024) FROM task_materials_v1 WHERE task_id=$1)::text sidecars,
   octet_length(c.signature_envelope)+octet_length(c.signed_payload_text)+octet_length(c.intent::text)+512 proof FROM consents c JOIN task_events e ON e.consent_id=c.id WHERE e.id=$2`,[p.request.taskId,p.request.operationId])).rows[0];
  assert(after.payloadBytes-before.payloadBytes>BigInt(bytes.sidecars)+BigInt(bytes.proof));
 }finally{await f.close();}
});

test('actual API and worker SET ROLE publish/read/erase materials but cannot rewrite source commitments, consent or control',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f);await f.db.exec(await readFile(new URL('../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));await f.db.exec('SET ROLE galaxy_api');
  await f.ok('/v2/tasks',{input:p.input});assert.equal((await f.ok('/v2/tasks/'+p.request.taskId)).request.title,p.post.title);
  for(const sql of ['UPDATE task_materials_v1 SET descriptor=descriptor','UPDATE task_materials_v1 SET text_hash=text_hash','UPDATE task_materials_v1 SET consent_id=consent_id','DELETE FROM task_materials_v1'])await assert.rejects(f.db.query(sql),e=>e.code==='42501');
  await f.owner.consents.revoke(f.owner.actor,p.source.consentId);await f.db.exec('RESET ROLE');await f.db.exec('SET ROLE galaxy_evidence_worker');
  const erased=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint});assert.equal(erased.removed.taskMaterialBodiesErased,2);
  assert.equal((await f.db.query("SELECT count(*) n FROM task_materials_v1 WHERE body_text<>''")).rows[0].n,0);
  for(const sql of ['UPDATE task_materials_v1 SET descriptor=descriptor','UPDATE task_materials_v1 SET expires_at=expires_at','INSERT INTO task_materials_v1 SELECT * FROM task_materials_v1 WHERE false','UPDATE consents SET revoked_at=now()','UPDATE bindings SET revoked_at=now()'])await assert.rejects(f.db.query(sql),e=>e.code==='42501');
 }finally{await f.db.exec('RESET ROLE');await f.close();}
});

test('retained original material root authorization and audits stay measured after bounded sidecar metadata removal; forum cleanup stays separate',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f,{expiry:30});await f.ok('/v2/tasks',{input:p.input});f.clock.now+=31;
  const first=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint});assert.equal(first.removed.taskMaterialBodiesErased,2);
  f.clock.now+=180*86400+1;const later=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,endpoint:f.owner.access.endpoint});assert.equal(later.removed.taskMaterialReceiptsRemoved,2);
  assert.equal((await f.db.query('SELECT count(*) n FROM task_materials_v1')).rows[0].n,0);
  const consent=(await f.db.query('SELECT c.id,c.intent FROM consents c JOIN task_events e ON e.consent_id=c.id WHERE e.id=$1',[p.request.operationId])).rows[0];assert(consent);
  assert.equal((await f.db.query('SELECT payload_text FROM task_events WHERE id=$1',[p.request.operationId])).rows[0].payload_text,p.input.payloadJson);
  const before=await subjectResourceUsage(f.db,f.owner.actor.subjectId,f.clock.now);
  const measured=(await f.db.query(`SELECT octet_length(c.signature_envelope)+octet_length(c.signed_payload_text)+octet_length(c.intent::text)+512 AS proof,
   (SELECT sum(octet_length(to_jsonb(a)::text)+512) FROM audit_events a WHERE a.actor=$2 AND a.object_id IN(c.id::text,c.intent->>'objectId'))::text audits FROM consents c WHERE c.id=$1`,[consent.id,f.owner.actor.subjectId])).rows[0];
  await f.db.query("UPDATE consents SET intent=jsonb_set(intent,'{fields}',(intent->'fields')-'materials') WHERE id=$1",[consent.id]);
  // Controlled accounting-only comparison after business assertions: removing
  // the classification proves these retained bytes remain in the real meter.
  const without=await subjectResourceUsage(f.db,f.owner.actor.subjectId,f.clock.now);
  assert.equal(before.payloadBytes-without.payloadBytes,BigInt(measured.proof)+BigInt(measured.audits));
  await f.db.query('UPDATE consents SET intent=$2 WHERE id=$1',[consent.id,JSON.stringify(consent.intent)]);
  assert.equal((await subjectResourceUsage(f.db,f.owner.actor.subjectId,f.clock.now)).payloadBytes,before.payloadBytes);
 }finally{await f.close();}
});

test('direct service MCP path enforces the same complete UTF8 material envelope limit before any authorization growth',async()=>{
 const f=await communityForumFixture();try{
  const p=await materialTask(f),lengths=[120,2600,2000,2000,2000,2000,2000,1500];
  const selections=lengths.map((length,index)=>({materialId:randomUUID(),field:index===0?'title':'body',start:0,end:1,text:'漢'.repeat(length)}));
  const prepared=await f.ok('/v2/task-materials/prepare',{input:{source:{postId:p.post.postId,versionId:p.post.versionId},selections,expiresAt:p.post.publishedUntil}});
  const segment=index=>({kind:'material',materialId:selections[index].materialId}),text=segments=>({format:'task-text-v1',segments});
  const request={...p.request,title:text([segment(0)]),summary:text([{kind:'literal',text:'漢'.repeat(7400)},segment(1)]),
   workContext:{goal:'漢'.repeat(10000),currentSituation:text([2,3,4,5,6].map(segment)),attemptRefs:[]},expectedOutcome:text([segment(7)]),materials:prepared.descriptors};
  taskRequestV2Schema.parse(request);const payloadJson=JSON.stringify(request),intent={...p.intent,id:randomUUID(),fields:Object.keys(request),payloadHash:digest(payloadJson)};
  const input={signedIntent:await f.owner.signForTest(JSON.stringify(intent),'galaxy-consent+jws'),payloadJson,materialBodies:prepared.materialBodies};
  taskMaterialSubmissionSchema.parse(input);assert(Buffer.byteLength(JSON.stringify(input))>100000);
  const counts=async()=>({consents:(await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,
   audits:(await f.db.query('SELECT count(*) n FROM audit_events')).rows[0].n,tasks:(await f.db.query('SELECT count(*) n FROM task_requests')).rows[0].n});
  const before=await counts();await assert.rejects(f.owner.assistance.createTask(f.owner.actor,input),error=>error.code==='request_too_large'&&error.status===413);
  assert.deepEqual(await counts(),before);assert.equal((await f.db.query('SELECT count(*) n FROM task_materials_v1')).rows[0].n,0);
 }finally{await f.close();}
});
