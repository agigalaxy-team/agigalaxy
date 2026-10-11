import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {forumAccountUsage} from '../src/community-forum-budget-v1.mjs';
import {defaultForumPolicy} from '../src/community-forum-policy-v1.mjs';
import {defaultResourceBudgetPolicy,subjectResourceUsage} from '../src/infrastructure/resource-budgets.mjs';

test('atomic terminal/CAS/signature failure cannot grow Consent, accepted audits or records; generic forum grants rejected',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'atomic-exit');const p=await f.post(),w=await f.write(f.owner,'create-post',p);assert.equal(w.status,200);
  const withdrawal={schemaVersion:1,operationId:randomUUID(),postId:p.postId,expectedHeadVersion:1};assert.equal((await f.write(f.owner,'withdraw-post',withdrawal)).status,200);
  const account=(await f.owner.communityAccounts.resolveWithin(f.db,f.owner.actor)).id;
  async function counts(){return {meter:String(await forumAccountUsage(f.db,account)),consents:(await f.db.query("SELECT count(*) n FROM consents WHERE intent->>'action' LIKE 'forum.%'")).rows[0].n,audits:(await f.db.query("SELECT count(*) n FROM audit_events WHERE action LIKE 'forum.%' OR action='consent.create'")).rows[0].n,events:(await f.db.query('SELECT count(*) n FROM forum_events_v1')).rows[0].n,receipts:(await f.db.query('SELECT count(*) n FROM forum_write_receipts_v1')).rows[0].n};}
  const before=await counts();for(let i=0;i<3;i++)assert.equal((await f.write(f.owner,'withdraw-post',{...withdrawal,operationId:randomUUID(),expectedHeadVersion:2})).status,409);
  assert.deepEqual(await counts(),before);
  const input=await f.authorize(f.owner,'withdraw-post',{...withdrawal,operationId:randomUUID(),expectedHeadVersion:2});
  await assert.rejects(f.owner.consents.create(f.owner.actor,input.signedIntent),error=>error.code==='forum_atomic_write_required');assert.deepEqual(await counts(),before);
  const q=await f.post(),signed=await f.authorize(f.owner,'create-post',q),parts=signed.signedIntent.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  assert.equal((await f.request('/v2/community/posts',{input:{...signed,signedIntent:parts.join('.')}})).status,400);assert.deepEqual(await counts(),before);
  assert.equal((await f.db.query('SELECT count(*) n FROM forum_posts_v1 WHERE id=$1',[q.postId])).rows[0].n,0);
  assert.equal((await f.owner.access.authenticate(f.owner.credential)).subjectId,f.owner.actor.subjectId);
 }finally{await f.close();}
});

test('true shared Account daily forum quota is independent of unchanged Task/comment quota and no failed grant growth',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'shared-forum-account');await f.login(f.responder,'shared-forum-account');
  for(let i=0;i<3;i++)assert.equal((await f.write(f.owner,'create-post',await f.post())).status,200);
  const denied=await f.write(f.responder,'create-post',await f.post());assert.equal(denied.status,429);assert.equal(denied.body.error,'forum_quota_exceeded');
  assert.equal((await f.db.query("SELECT count(*) n FROM consents WHERE intent->>'action' LIKE 'forum.%'")).rows[0].n,3);
  const status=await f.ok('/v2/community/quotas',{who:f.responder});assert.equal(status.quotas.find(x=>x.category==='post').remaining,0);assert.equal(status.quotas.find(x=>x.category==='reply').limit,30);
  const old=await f.owner.publicWrites.status(f.owner.actor);assert.equal(old.quotas.find(x=>x.kind==='task'||x.category==='task').limit,2);assert.equal(old.quotas.find(x=>x.kind==='comment'||x.category==='comment').limit,20);
  assert.equal((await f.db.query('SELECT count(*) n FROM community_interactions')).rows[0].n,0);
 }finally{await f.close();}
});

test('actual accepted bytes include original signature/intent/audits; finite exit remains available at storage cap',async()=>{
 const f=await communityForumFixture({policy:{...defaultForumPolicy,new:{...defaultForumPolicy.new,post:12},accountForumMaxBytes:65536}});try{
  await f.login(f.owner,'storage-account');const p=await f.post({body:'A'.repeat(8000)}),w=await f.write(f.owner,'create-post',p);assert.equal(w.status,200);
  const account=(await f.owner.communityAccounts.resolveWithin(f.db,f.owner.actor)).id;
  const evidence=(await f.db.query('SELECT sum(octet_length(signature_envelope)+octet_length(signed_payload_text)+octet_length(intent::text)) bytes FROM consents WHERE id=$1',[w.consentId])).rows[0].bytes;
  assert.ok(await forumAccountUsage(f.db,account)>BigInt(evidence)+8000n);
  let failed=null;for(let i=0;i<5;i++){const out=await f.write(f.owner,'create-post',await f.post({body:'B'.repeat(8000)}));if(out.status!==200){failed=out;break;}}
  assert.equal(failed.status,409);assert.equal(failed.body.error,'forum_storage_quota_exceeded');
  const before=(await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,exit={schemaVersion:1,operationId:randomUUID(),postId:p.postId,expectedHeadVersion:1};assert.equal((await f.write(f.owner,'withdraw-post',exit)).status,200);
  assert.equal((await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,before+1);
  assert.equal((await f.write(f.owner,'withdraw-post',{...exit,operationId:randomUUID(),expectedHeadVersion:2})).status,409);
  assert.equal((await f.db.query('SELECT count(*) n FROM consents')).rows[0].n,before+1);
 }finally{await f.close();}
 const g=await communityForumFixture({resourceBudgetPolicy:{...defaultResourceBudgetPolicy,maxPayloadBytesPerSubject:8000}});try{
  await g.login(g.owner,'global-guid-budget');const before=await subjectResourceUsage(g.db,g.owner.actor.subjectId,g.clock.now),out=await g.write(g.owner,'create-post',await g.post({body:'C'.repeat(4000)}));assert.equal(out.status,409);assert.equal(out.body.error,'storage_quota_exceeded');
  assert.equal((await g.db.query('SELECT count(*) n FROM forum_events_v1')).rows[0].n,0);assert.equal((await g.db.query("SELECT count(*) n FROM consents WHERE intent->>'action' LIKE 'forum.%'")).rows[0].n,0);assert.equal((await subjectResourceUsage(g.db,g.owner.actor.subjectId,g.clock.now)).payloadBytes,before.payloadBytes);
 }finally{await g.close();}
});
