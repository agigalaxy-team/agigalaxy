import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {digest} from '../src/shared/digest.mjs';

test('real HTTP/OIDC/signatures: ordinary post -> exact independent version -> exact reply -> withdraw -> own locator',async()=>{
 const f=await communityForumFixture();try{
  const p=await f.post();assert.equal((await f.write(f.owner,'create-post',p)).body.error,'account_verification_required');
  await f.login(f.owner,'forum-owner');await f.login(f.responder,'forum-responder');
  const written=await f.write(f.owner,'create-post',p);assert.equal(written.status,200,JSON.stringify(written.body));
  const again=await f.ok('/v2/community/posts',{input:written.input});assert.equal(again.versionId,p.versionId);
  const first=await f.ok(`/v2/community/posts/${p.postId}/versions/${p.versionId}`,{authorization:false});assert.equal(first.payload.body,p.body);assert.equal(first.publishedUntil,p.publishedUntil);
  const q=await f.post({postId:p.postId,expectedHeadVersion:1,title:'New independent version'});assert.equal((await f.write(f.owner,'publish-version',q)).status,200);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}/versions/${p.versionId}`,{authorization:false})).availability,'available');
  const r=await f.reply(p);assert.equal((await f.write(f.responder,'create-reply',r)).status,200);
  assert.equal((await f.ok(`/v2/community/replies/${r.replyId}`,{authorization:false})).locator.postVersionId,p.versionId);
  const withdraw={schemaVersion:1,operationId:randomUUID(),postId:p.postId,expectedHeadVersion:2};assert.equal((await f.write(f.owner,'withdraw-post',withdraw)).status,200);
  const gone=await f.ok(`/v2/community/posts/${p.postId}/versions/${p.versionId}`,{authorization:false});assert.deepEqual(Object.keys(gone).sort(),['availability','checkedAt','locator']);
  const surviving=await f.ok(`/v2/community/replies/${r.replyId}`,{authorization:false});assert.equal(surviving.payload.body,r.body);assert.equal(surviving.parentAvailability,'withdrawn');
  const blocked=await f.write(f.responder,'create-reply',await f.reply(p));assert.equal(blocked.status,403);
  const owned=await f.ok(`/v2/community/posts/${p.postId}/owned`);assert.equal(owned.versionLocators.length,2);assert.ok(owned.versionLocators[0].permissionId);assert.equal(JSON.stringify(owned).includes(p.body),false);
  assert.equal((await f.request(`/v2/community/posts/${p.postId}/owned`,{who:f.responder})).status,404);
  const freshNoop={...withdraw,operationId:randomUUID(),expectedHeadVersion:3};assert.equal((await f.write(f.owner,'withdraw-post',freshNoop)).status,409);
  const receipt=await f.ok('/v2/community/receipt',{input:{operationId:p.operationId,payloadHash:digest(written.input.payloadJson)}});assert.equal(receipt.status,'acknowledged');
  assert.equal((await f.db.query('SELECT used FROM forum_daily_usage_v1 WHERE category=$1 AND account_id=(SELECT account_id FROM community_account_links WHERE subject_id=$2 LIMIT 1)',['post',f.owner.actor.subjectId])).rows[0].used,1);
  assert.equal((await f.db.query('SELECT count(*) n FROM task_requests')).rows[0].n,0);
 }finally{await f.close();}
});

test('exact signed input bounds and body-free unavailable response; insufficient bearer is ignored for public reads',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'forum-bounds');const p=await f.post(),w=await f.write(f.owner,'create-post',p);assert.equal(w.status,200,JSON.stringify(w.body));
  const altered={...w.input,payloadJson:JSON.stringify({...p,title:'Tampered'})};assert.equal((await f.request('/v2/community/posts',{input:altered})).status,409);
  const unknown=await f.request('/v2/community/posts',{input:{...w.input,unexpected:true}});assert.equal(unknown.status,400);
  const unsupported=await f.write(f.owner,'publish-version',await f.post({postId:p.postId,expectedHeadVersion:99}));assert.equal(unsupported.status,409);
  const q=await f.request(`/v2/community/posts/${p.postId}`,{who:{credential:'insufficient-or-invalid'}});assert.equal(q.status,200);assert.equal(q.body.payload.title,p.title);
  const quota=await f.ok('/v2/community/quotas');assert.equal(quota.accountVerified,true);assert.equal(quota.policyHash,f.forum.policyHash);
  await f.owner.consents.revoke(f.owner.actor,w.consentId);
  const gone=await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false});assert.deepEqual(Object.keys(gone).sort(),['availability','checkedAt','locator']);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}/owned`)).versionLocators[0].availability,'unavailable');
 }finally{await f.close();}
});
