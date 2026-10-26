import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publicationFixture} from '../../galaxy-official/test/task-publication-continuity-fixture.mjs';
import {ServiceError} from '../../galaxy-official/src/shared/service-error.mjs';
import {createCommunityForumClient} from "../src/features/community-forum/community-forum-client.mjs";
import {createTaskMaterialClient,materialTaskText,taskMaterialProjectionKey,withholdTaskMaterialTree} from "../src/features/tasks/materials/task-material-client.mjs";

// Production WebRuntime, signed HTTP, verified synthetic account and PGlite.
// The fixture's local Map and deliberate admission/ACK failures are test doubles.
async function sourceFor(f,t){
 const now=f.f.access.now(),subjectId=f.runtime.api.snapshot().subjectId;
 const forum=createCommunityForumClient(f.runtime,{subjectId,now:()=>now});t.after(()=>forum.close());
 const preview=await forum.prepare('create-post',{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),expectedHeadVersion:0,
  versionId:randomUUID(),title:'Runtime material title',body:'Runtime exact source body.',links:[],publishedUntil:now+3600});
 await forum.execute(preview,{confirmed:true});
 const material=createTaskMaterialClient(f.runtime,{subjectId,now:()=>now});t.after(()=>material.close());
 const selected=await material.prepare({source:{postId:preview.payload.postId,versionId:preview.payload.versionId},expiresAt:now+1800,
  selections:[{materialId:randomUUID(),field:'title',start:0,end:[...preview.payload.title].length},
   {materialId:randomUUID(),field:'body',start:0,end:[...preview.payload.body].length,text:'My edited source description.'}]});
 const draft={...f.draft,visibility:'Public',title:materialTaskText(selected.descriptors[0].materialId),
  summary:{format:'task-text-v1',segments:[{kind:'literal',text:'Independent requester note. '},{kind:'material',materialId:selected.descriptors[1].materialId}]},
  materials:selected.descriptors};
 return{draft,bodies:selected.materialBodies,post:preview.payload,forum,async withdraw(){
  const current=createCommunityForumClient(f.runtime,{subjectId,now:()=>now});
  try{await current.execute(await current.prepare('withdraw-version',{schemaVersion:1,operationId:randomUUID(),postId:preview.payload.postId,
   versionId:preview.payload.versionId,expectedHeadVersion:1}),{confirmed:true});}finally{current.close();}
 }};
}
function admission(f){const original=f.f.assistance.createTask.bind(f.f.assistance),state={blocked:true};
 f.f.assistance.createTask=(...args)=>{if(state.blocked)throw new ServiceError('consent_required',403);return original(...args);};return state;}
const getTask=(f,id)=>f.runtime.api.call('/v2/tasks/'+id,null,{method:'GET'});

test('material publication uses one atomic signed submission; current reading and limited shares retain exact source authority',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const source=await sourceFor(f,t),before={...f.counts};
 f.hooks.loseAck=true;await assert.rejects(f.runtime.publishTask(source.draft,{confirmed:true,materialBodies:source.bodies}),/lost task publication ACK/);
 const original=await f.runtime.getLocal('task-publication');assert.ok(original.submission.signedIntent);assert.equal(original.submission.consentId,undefined);
 assert.equal(f.counts.consents,before.consents,'material consent is accepted atomically by /v2/tasks');
 const receipt=await f.runtime.resumePublication();assert.equal(receipt.state,'acknowledged');assert.equal(f.counts.publications,before.publications+1);
 const task=await getTask(f,receipt.taskId);assert.equal(task.request.title,source.post.title);assert.equal(task.request.summary,'Independent requester note. My edited source description.');
 assert.equal(task._webTaskScope,f.runtime.taskDraftScope().key);assert.equal(task.rootRequest.title.format,'task-text-v1');
 const shared=await f.runtime.api.call('/v2/contributions/preview',{sourceRefs:[{kind:'task-event',id:receipt.eventId,eventVersion:1,payloadHash:original.payloadHash,fields:['eventType','actorId','title']}],purposes:['honor']});
 const projection=shared.items[0].projection;assert.equal(projection.taskId,undefined);assert.equal(projection.summary,undefined);
 assert.equal(projection._webTaskRead.source.id,receipt.eventId);assert.equal(projection._webTaskRead.purpose,'honor');
 assert.equal(JSON.stringify(projection).includes('_webTaskRead'),false,'recheck metadata is neither product data nor persisted draft content');
 const current=(await f.runtime.api.call('/v2/contributions/read',projection._webTaskRead)).projection;
 const safe=withholdTaskMaterialTree(shared,f.f.access.now(),{current:new Map([[taskMaterialProjectionKey(projection),current]])});
 assert.equal(safe.items[0].projection.title,source.post.title);assert.equal(safe.items[0].projection.taskId,undefined);assert.equal(safe.items[0].projection.summary,undefined);
 await source.withdraw();const unavailable=await getTask(f,receipt.taskId);assert.equal(unavailable.request.title,'');assert.equal(unavailable.request.summary,'Independent requester note. ');
 const event=(await f.f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE id=$1',[receipt.eventId])).rows[0];
 assert.equal(event.payload_text,original.payloadJson);assert.equal(event.payload_hash,original.payloadHash);
});

test('material rejection pauses automatic retries and explicit reauthorization preserves the original across reconnect',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const source=await sourceFor(f,t),failure=admission(f);
 await assert.rejects(f.runtime.publishTask(source.draft,{confirmed:true,materialBodies:source.bodies}),{code:'consent_required'});
 const original=await f.runtime.getLocal('task-publication'),before={...f.counts};
 await assert.rejects(f.runtime.resumePublication(),{code:'publication_business_rejected'});assert.equal(f.counts.publications,before.publications);
 await f.reconnect();failure.blocked=false;const preview=await f.runtime.reviewTaskAuthorization();
 assert.equal(preview.state,'reauthorization-required');assert.equal(preview.payloadHash,original.payloadHash);assert.equal(preview.payload.operationId,original.payload.operationId);
 assert.equal(preview.expiresAt,original.authorizationExpiresAt);assert.deepEqual(preview.materialBodies,source.bodies);
 const receipt=await f.runtime.reauthorizeTaskOperation(preview,{confirmed:true});assert.equal(receipt.taskId,original.payload.taskId);assert.equal(receipt.version,1);assert.equal(receipt.eventId,original.payload.operationId);
 assert.equal(f.counts.consents,before.consents);assert.equal(f.counts.publications,before.publications+1);
 const rows=(await f.f.db.query('SELECT payload_text,payload_hash FROM task_events WHERE id=$1',[receipt.eventId])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].payload_text,original.payloadJson);assert.equal(rows[0].payload_hash,original.payloadHash);
});

test('withdrawal erases only pending material bodies and prevents resending while retaining the original receipt coordinates',async t=>{
 const f=await publicationFixture();t.after(()=>f.close());const source=await sourceFor(f,t),failure=admission(f);
 await assert.rejects(f.runtime.publishTask(source.draft,{confirmed:true,materialBodies:source.bodies}),{code:'consent_required'});
 const original=await f.runtime.getLocal('task-publication'),before={...f.counts};await source.withdraw();failure.blocked=false;
 const retained=await f.runtime.getLocal('task-publication');assert.deepEqual(retained.materialBodies,[]);
 assert.equal(retained.payloadJson,original.payloadJson);assert.equal(retained.payloadHash,original.payloadHash);assert.ok(retained.payload.summary.segments.some(value=>value.text==='Independent requester note. '));
 await assert.rejects(f.runtime.resumePublication({explicitRetry:true}),{code:'task_material_unavailable'});
 assert.equal(f.counts.publications,before.publications);assert.equal((await f.runtime.reconcilePublication()).state,'absent');
 const stopped=await f.runtime.reviewTaskStop();assert.equal(stopped.state,'stop-local-preview');assert.equal(stopped.eventId,original.payload.operationId);
});
