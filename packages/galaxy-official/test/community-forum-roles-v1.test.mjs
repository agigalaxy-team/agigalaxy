import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {cleanupProductV2Retention} from '../src/operations/lifecycle-retention-v2.mjs';

test('actual PostgreSQL kernel API/worker roles permit forum workflow and bounded erasure while rejecting source/control mutations',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'role-author');await f.login(f.responder,'role-reporter');
  await f.db.exec(await readFile(new URL('../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
  await f.db.exec('SET ROLE galaxy_api');
  const p=await f.post(),published=await f.write(f.owner,'create-post',p);assert.equal(published.status,200,JSON.stringify(published.body));
  const reply=await f.reply(p);assert.equal((await f.write(f.responder,'create-reply',reply)).status,200);
  const report={schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'privacy',summary:'Private role test report.'};
  const reported=await f.write(f.responder,'create-report',report,{viewers:[f.moderator.actor.subjectId]});assert.equal(reported.status,200,JSON.stringify(reported.body));
  const resolution={schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:report.reportId,expectedReportVersion:1,kind:'resolve',resolution:'dismissed',reason:'Role-bound independent decision.',effect:null};
  assert.equal((await f.write(f.moderator,'resolve',resolution,{viewers:[f.owner.actor.subjectId,f.responder.actor.subjectId]})).status,200);
  const withdraw={schemaVersion:1,operationId:randomUUID(),postId:p.postId,expectedHeadVersion:1};assert.equal((await f.write(f.owner,'withdraw-post',withdraw)).status,200);
  for(const sql of [
   "UPDATE forum_events_v1 SET payload_text='rewritten'", "DELETE FROM forum_events_v1", "UPDATE forum_permissions_v1 SET signer_public_key='replaced'",
   "UPDATE forum_permissions_v1 SET authorization_audit_until=now()", "UPDATE community_accounts SET issuer=issuer", "SELECT public.galaxy_worker_prune_forum_authorizations(now())",
  ])await assert.rejects(f.db.query(sql),error=>error.code==='42501',sql);
  for(const column of ['restricted_until','restriction_reason','restriction_revision'])assert.equal((await f.db.query("SELECT has_column_privilege('galaxy_api','community_accounts',$1,'UPDATE') permitted",[column])).rows[0].permitted,true,column);
  for(const column of ['id','uid','endpoint','issuer','external_subject','created_at'])assert.equal((await f.db.query("SELECT has_column_privilege('galaxy_api','community_accounts',$1,'UPDATE') permitted",[column])).rows[0].permitted,false,column);
  await f.owner.consents.revoke(f.owner.actor,published.consentId);
  await f.db.exec('RESET ROLE');await f.db.exec('SET ROLE galaxy_evidence_worker');
  const cleaned=await cleanupProductV2Retention(f.db,{now:()=>f.clock.now,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});
  assert.equal(cleaned.removed.forumBodies,1);assert.equal(cleaned.removed.forumPolicyHash,f.forum.policyHash);
  assert.equal((await f.db.query('SELECT payload_text FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0].payload_text,'');
  assert.ok((await f.db.query("SELECT 1 FROM lifecycle_erasure_records WHERE table_name='forum_events_v1' AND object_key=$1",[p.operationId])).rows.length);
  for(const sql of [
   "UPDATE forum_reports_v1 SET state='withdrawn'", "UPDATE bindings SET revoked_at=now()", "UPDATE consents SET revoked_at=now()",
   "DELETE FROM consents", "UPDATE device_authorizations SET status='revoked'", "UPDATE forum_permissions_v1 SET signer_public_key=signer_public_key",
   "INSERT INTO forum_events_v1 SELECT * FROM forum_events_v1 WHERE false", "INSERT INTO forum_permissions_v1 SELECT * FROM forum_permissions_v1 WHERE false",
  ])await assert.rejects(f.db.query(sql),error=>error.code==='42501',sql);
  assert.equal((await f.db.query("SELECT has_column_privilege('galaxy_evidence_worker','forum_permissions_v1','signer_public_key','SELECT') permitted")).rows[0].permitted,true,'current anonymous source reads may verify the stored public signer key');
  await f.db.exec('RESET ROLE');
  assert.equal((await f.ok(`/v2/community/replies/${reply.replyId}`,{authorization:false})).availability,'available');
 }finally{await f.db.exec('RESET ROLE');await f.close();}
});

test('authorization prune preserves remaining sources/receipts, clears a truly unreferenced aged record, and cannot fast-forward the stored audit deadline',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'prune-author');const actualNow=f.clock.now;
  // Production services and original signatures use a controlled retained
  // clock. This exercises ageing predicates, not a historical-host claim.
  f.clock.now-=211*86400;
  const p=await f.post(),published=await f.write(f.owner,'create-post',p);assert.equal(published.status,200,JSON.stringify(published.body));
  f.clock.now=actualNow;
  const prune=async before=>(await f.db.query('SELECT public.galaxy_worker_prune_forum_authorizations($1) result',[new Date(before*1000).toISOString()])).rows[0].result;
  assert.deepEqual(await prune(actualNow+100000000),{permissions:0,consents:0,audits:0});
  await f.db.query('DELETE FROM forum_versions_v1 WHERE id=$1',[p.versionId]);await f.db.query('DELETE FROM forum_posts_v1 WHERE id=$1',[p.postId]);await f.db.query('DELETE FROM forum_events_v1 WHERE id=$1',[p.operationId]);
  assert.deepEqual(await prune(actualNow),{permissions:0,consents:0,audits:0});
  assert.equal((await f.db.query('SELECT count(*) n FROM forum_permissions_v1 WHERE id=$1',[published.body.permissionId])).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*) n FROM consents WHERE id=$1',[published.consentId])).rows[0].n,1);
  await f.db.query('DELETE FROM forum_write_receipts_v1 WHERE operation_id=$1',[p.operationId]);
  const removed=await prune(actualNow);assert.equal(removed.permissions,1);assert.equal(removed.consents,1);assert.equal(removed.audits,2);
  assert.equal((await f.db.query('SELECT count(*) n FROM consents WHERE id=$1',[published.consentId])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*) n FROM audit_events WHERE consent_id=$1',[published.consentId])).rows[0].n,0);
  const q=await f.post(),fresh=await f.write(f.owner,'create-post',q);assert.equal(fresh.status,200);
  await f.db.query('DELETE FROM forum_versions_v1 WHERE id=$1',[q.versionId]);await f.db.query('DELETE FROM forum_posts_v1 WHERE id=$1',[q.postId]);await f.db.query('DELETE FROM forum_events_v1 WHERE id=$1',[q.operationId]);await f.db.query('DELETE FROM forum_write_receipts_v1 WHERE operation_id=$1',[q.operationId]);
  assert.deepEqual(await prune(actualNow+100000000),{permissions:0,consents:0,audits:0});
  assert.equal((await f.db.query('SELECT count(*) n FROM forum_permissions_v1 WHERE id=$1',[fresh.body.permissionId])).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*) n FROM consents WHERE id=$1',[fresh.consentId])).rows[0].n,1);
 }finally{await f.close();}
});
