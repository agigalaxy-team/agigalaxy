import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {cleanupProductV2Retention} from '../src/operations/lifecycle-retention-v2.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {digest} from '../src/shared/digest.mjs';

test('30d forum permission survives natural24h binding expiry; old Task live Consent stays strict; explicit old-binding revocation stops forum',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'long-forum');const p=await f.post(),w=await f.write(f.owner,'create-post',p);assert.equal(w.status,200);
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'Separate actual Task',summary:'Existing live-grant predicate',workContext:{goal:'Review',currentSituation:'Prepared',attemptRefs:[]},visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.clock.now+2592000};
  await f.owner.assistance.createTask(f.owner.actor,await f.owner.authorize(task,'assistance.publish',{objectId:task.operationId,visibility:'Public',purpose:'public-profile',expiresAt:f.clock.now+2592000}));
  const originalBinding=f.owner.actor.bindingId;f.clock.now+=86401;
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).availability,'available');
  await assert.rejects(f.owner.assistance.getPublicTask(task.taskId),error=>[403,404].includes(error.status));
  await f.reconnect(f.owner);const detail=await f.ok(`/v2/community/permissions/${w.body.permissionId}`);assert.ok(detail.originBindingExpiresAt<f.clock.now);assert.deepEqual(detail.stoppedReasons,[]);
  await f.owner.bindings.revoke(originalBinding,f.owner.actor.subjectId,randomUUID(),null,f.owner.actor);
  assert.deepEqual(Object.keys(await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).sort(),['availability','checkedAt','locator']);
  const after=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});assert.equal(after.removed.forumPolicyHash,f.forum.policyHash);assert.equal(after.removed.forumBodies,1);
  const erased=(await f.db.query('SELECT payload_text,erased_at FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0];assert.equal(erased.payload_text,'');assert.ok(erased.erased_at);
  const ledger=(await f.db.query('SELECT original_payload_hash FROM lifecycle_erasure_records WHERE table_name=$1 AND object_key=$2',['forum_events_v1',p.operationId])).rows[0];assert.equal(ledger.original_payload_hash,digest(w.input.payloadJson));
 }finally{await f.close();}
});

test('private owner export uses fresh permission; expired/revoked body never returns, existing synchronous export still works',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'export-forum');await f.login(f.responder,'export-target');const p=await f.post(),w=await f.write(f.responder,'create-post',p);assert.equal(w.status,200);
  const report={schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'privacy',summary:'Owner private statement to export only while authorized.'};
  const r=await f.write(f.owner,'create-report',report,{viewers:[f.moderator.actor.subjectId]});assert.equal(r.status,200);
  const ticket=await f.owner.dataExport.create(f.owner.actor,{id:randomUUID(),datasets:['forum-governance-events','identity']});
  const before=await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'forum-governance-events'});assert.equal(before.items[0].payload_text,r.input.payloadJson);
  assert.equal((await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'identity'})).items[0].id,f.owner.actor.subjectId);
  await f.owner.consents.revoke(f.owner.actor,r.consentId);
  const after=await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'forum-governance-events'});assert.equal(after.items[0].payload_text,'');assert.equal(after.items[0].contentAvailable,false);assert.equal(JSON.stringify(after).includes(report.summary),false);
  const cleanup=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});assert.equal(cleanup.removed.forumGovernanceBodies,1);
 }finally{await f.close();}
});

test('pending deletion only hides and preserves body; cancellation restores valid permission; approved deletion erases source but preserves independent reply',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'deleted-parent');await f.login(f.responder,'surviving-reply');const p=await f.post(),w=await f.write(f.owner,'create-post',p),r=await f.reply(p);assert.equal(w.status,200);assert.equal((await f.write(f.responder,'create-reply',r)).status,200);
  const request={version:1,id:randomUUID(),endpoint:f.owner.access.endpoint,subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,issuedAt:f.clock.now,expiresAt:f.clock.now+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
  const pending=await f.owner.deletion.submit(f.owner.actor,await f.owner.signForTest(JSON.stringify(request),'galaxy-deletion-intent+jws'));
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).availability,'unavailable');
  await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});assert.equal((await f.db.query('SELECT payload_text FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0].payload_text,w.input.payloadJson);
  const cancel={...request,id:randomUUID(),action:'cancel',requestId:pending.id,expectedRevision:1};delete cancel.scope;delete cancel.reason;delete cancel.takeout;
  await f.owner.deletion.submit(f.owner.actor,await f.owner.signForTest(JSON.stringify(cancel),'galaxy-deletion-intent+jws'));assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).availability,'available');
  const command=await approveFixtureDeletion(f.owner,f.db,{auditUntil:f.clock.now+60}),result=await executeDeletion(f.db,command,{now:()=>f.clock.now});assert.equal(result.physicalDeletionPerformed,true);assert.equal(result.serviceWideDeletionComplete,false);
  const surviving=await f.ok(`/v2/community/replies/${r.replyId}`,{authorization:false});assert.equal(surviving.payload.body,r.body);assert.equal(JSON.stringify(surviving).includes(p.body),false);
  const retained=(await f.db.query('SELECT subject_id,state FROM forum_versions_v1 WHERE id=$1',[p.versionId])).rows[0];assert.equal(retained.subject_id,null);assert.equal(retained.state,'withdrawn');
  assert.equal((await f.db.query('SELECT count(*) n FROM forum_events_v1 WHERE subject_id=$1 AND payload_text<>\'\'',[f.owner.actor.subjectId])).rows[0].n,0);
 }finally{await f.close();}
});

test('independent exact expiry, single-version/reply withdrawal and current export never reuse expired parent text',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'exact-expiry-author');await f.login(f.responder,'exact-expiry-reply');
  const p=await f.post({publishedUntil:f.clock.now+60}),q=await f.post({postId:p.postId,expectedHeadVersion:1,publishedUntil:f.clock.now+300}),r=await f.reply(p,{publishedUntil:f.clock.now+180});
  assert.equal((await f.write(f.owner,'create-post',p)).status,200);assert.equal((await f.write(f.owner,'publish-version',q)).status,200);assert.equal((await f.write(f.responder,'create-reply',r)).status,200);
  const ticket=await f.owner.dataExport.create(f.owner.actor,{id:randomUUID(),datasets:['authorized-views','forum-events'],views:[{kind:'forum-post-version',id:p.postId,versionId:p.versionId}]});
  assert.equal((await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'authorized-views'})).items[0].view.payload.body,p.body);
  f.clock.now+=61;
  const expired=await f.ok(`/v2/community/posts/${p.postId}/versions/${p.versionId}`,{authorization:false});assert.equal(expired.availability,'expired');assert.deepEqual(Object.keys(expired).sort(),['availability','checkedAt','locator']);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).payload.versionId,q.versionId);
  const exported=await f.owner.dataExport.page(f.owner.actor,{id:ticket.id,dataset:'authorized-views'});assert.equal(exported.items[0].view.availability,'expired');assert.equal('payload' in exported.items[0].view,false);
  const reply=await f.ok(`/v2/community/replies/${r.replyId}`,{authorization:false});assert.equal(reply.payload.body,r.body);assert.equal(reply.parentAvailability,'expired');
  assert.equal((await f.write(f.responder,'create-reply',await f.reply(p))).status,403);
  const withdrawVersion={schemaVersion:1,operationId:randomUUID(),postId:p.postId,versionId:p.versionId,expectedHeadVersion:2};assert.equal((await f.write(f.owner,'withdraw-version',withdrawVersion)).status,200);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).payload.versionId,q.versionId);
  const withdrawReply={schemaVersion:1,operationId:randomUUID(),replyId:r.replyId,expectedRevision:1};assert.equal((await f.write(f.owner,'withdraw-reply',withdrawReply)).status,404);assert.equal((await f.write(f.responder,'withdraw-reply',withdrawReply)).status,200);
  assert.equal((await f.ok(`/v2/community/replies/${r.replyId}/owned`,{who:f.responder})).state,'withdrawn');
  assert.deepEqual(Object.keys(await f.ok(`/v2/community/replies/${r.replyId}`,{authorization:false})).sort(),['availability','checkedAt','locator']);
  const cleaned=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});assert.equal(cleaned.removed.forumBodies,2);
  assert.equal((await f.db.query("SELECT count(*) n FROM forum_events_v1 WHERE id=ANY($1::uuid[]) AND payload_text<>''",[[p.operationId,r.operationId]])).rows[0].n,0);
 }finally{await f.close();}
});
