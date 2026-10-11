import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
import * as z from 'zod/v4';
import {bindForumIds,assertForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {forumWriteSpec} from '../src/shared/community-forum-v1-schema.mjs';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {cleanupProductV2Retention} from '../src/operations/lifecycle-retention-v2.mjs';
import {forumBudgetTables} from '../src/community-forum-budget-v1.mjs';

const fixedSubject='GUID15'+'0'.repeat(26),fixed={schemaVersion:1,operationId:'11111111-1111-4111-8111-111111111111',postId:'22222222-2222-4222-8222-222222222222',expectedHeadVersion:0,versionId:'33333333-3333-4333-8333-333333333333',title:'Fixed ordinary post',body:'Exact text 银河 😀',links:['https://example.org/a?x=1'],publishedUntil:2000000000};
// Independent Node implementation of the specified wire formula, not the
// production stableJson/sha256Hex helpers. This is a grammar/digest vector.
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort((a,b)=>a<b?-1:a>b?1:0).map(key=>[key,canonical(value[key])])):value;
const independent=(domain,kind,subjectId,payload)=>{
 const material={protocol:'galaxy-community-forum-locator',version:1,kind:domain,operationKind:kind,subjectId,payload},bytes=createHash('sha256').update(JSON.stringify(canonical(material)),'utf8').digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

test('fixed UUIDv8 vector is independently reproducible; exact content, operation, deadline and references bind locators without mutating input',async()=>{
 const old=structuredClone(fixed),actual=await bindForumIds('create-post',fixedSubject,fixed,webcrypto);assert.deepEqual(fixed,old);
 const {postId:ignoredPost,versionId:ignoredVersion,...postMaterial}=fixed;assert.ok(ignoredPost&&ignoredVersion);
 assert.equal(actual.postId,independent('post','create-post',fixedSubject,postMaterial));
 const {versionId:ignored,...versionMaterial}=actual;assert.ok(ignored);assert.equal(actual.versionId,independent('post-version','create-post',fixedSubject,versionMaterial));
 assert.equal(actual.postId,'141e362d-ea90-88f3-9d9b-9e93b98c12d2');assert.equal(actual.versionId,'9ef89c22-595a-869f-8d50-189231d65155');assert.equal(z.uuid().safeParse(actual.versionId).success,true);
 assert.deepEqual(await bindForumIds('create-post',fixedSubject,{...fixed,postId:randomUUID(),versionId:randomUUID()}),actual);
 for(const change of [{operationId:randomUUID()},{body:fixed.body+' '},{publishedUntil:fixed.publishedUntil+1},{links:['https://example.org/b']}]){
  const changed=await bindForumIds('create-post',fixedSubject,{...fixed,...change});assert.notEqual(changed.postId,actual.postId);assert.notEqual(changed.versionId,actual.versionId);
 }
 assert.notEqual((await bindForumIds('create-post','GUID15'+'1'.repeat(26),fixed)).postId,actual.postId);
 await assert.rejects(bindForumIds('create-post',fixedSubject.toLowerCase(),fixed),error=>error.code==='invalid_forum_subject');
 await assert.rejects(bindForumIds('create-post',randomUUID(),fixed),error=>error.code==='invalid_forum_subject');
 const version={...actual,operationId:randomUUID(),expectedHeadVersion:1},boundVersion=await bindForumIds('publish-version',fixedSubject,version);assert.equal(boundVersion.postId,actual.postId);
 assert.notEqual((await bindForumIds('publish-version',fixedSubject,{...version,postId:randomUUID()})).versionId,boundVersion.versionId);
 await assertForumIds('publish-version',fixedSubject,boundVersion);await assert.rejects(assertForumIds('publish-version',fixedSubject,version),error=>error.code==='forum_locator_mismatch');
 const withdrawal={schemaVersion:1,operationId:randomUUID(),postId:actual.postId,versionId:actual.versionId,expectedHeadVersion:2};assert.deepEqual(await bindForumIds('withdraw-version',fixedSubject,withdrawal),withdrawal);
});

async function snapshot(f){
 const counts={};for(const table of [...forumBudgetTables,'forum_daily_usage_v1','consents','audit_events'])counts[table]=(await f.db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n;
 const usage=[];for(const who of [f.owner,f.responder]){const value=await f.ok('/v2/community/quotas',{who});usage.push({bytes:value.storage.usedBytes,quotas:value.quotas});}
 return {counts,usage};
}
async function rejectUnchanged(f,who,kind,p,{viewers=[]}={}){
 const before=await snapshot(f),input=await f.authorize(who,kind,p,{viewers}),out=await f.request(forumWriteSpec(kind,p).path,{who,input});
 assert.equal(out.status,409,JSON.stringify(out.body));assert.equal(out.body.error,'forum_locator_mismatch');assert.deepEqual(await snapshot(f),before);return out;
}

test('real signed HTTP rejects actor/op/content/deadline/reference/report/event ID substitution before Consent, audit, quota or storage growth',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'locator-author');await f.login(f.responder,'locator-responder');const original=await f.post();
  for(const change of [{operationId:randomUUID()},{title:original.title+' changed'},{body:original.body+' changed'},{links:['https://example.org/new']},{publishedUntil:original.publishedUntil-1}])await rejectUnchanged(f,f.owner,'create-post',{...original,...change});
  await rejectUnchanged(f,f.responder,'create-post',original);
  assert.equal((await f.write(f.owner,'create-post',original)).status,200);
  const version=await f.post({postId:original.postId,expectedHeadVersion:1});await rejectUnchanged(f,f.owner,'publish-version',{...version,versionId:original.versionId});
  await rejectUnchanged(f,f.owner,'publish-version',{...version,publishedUntil:version.publishedUntil-1});
  const reply=await f.reply(original);await rejectUnchanged(f,f.responder,'create-reply',{...reply,postVersionId:randomUUID()});await rejectUnchanged(f,f.responder,'create-reply',{...reply,replyTo:{replyId:randomUUID(),contentRevision:1}});
  assert.equal((await f.write(f.responder,'create-reply',reply)).status,200);
  const report=await f.prepare(f.responder,'create-report',{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'reply',replyId:reply.replyId,contentRevision:1},category:'privacy',summary:'An exact private statement.'});
  await rejectUnchanged(f,f.responder,'create-report',{...report,summary:report.summary+' changed'},{viewers:[f.moderator.actor.subjectId]});
  assert.equal((await f.write(f.responder,'create-report',report,{viewers:[f.moderator.actor.subjectId]})).status,200);
  const decision=await f.prepare(f.moderator,'resolve',{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:report.reportId,expectedReportVersion:1,kind:'resolve',resolution:'accepted',reason:'This precise decision is separate from the original private report.',effect:{kind:'hide-version',until:f.clock.now+600}});
  await rejectUnchanged(f,f.moderator,'resolve',{...decision,effect:{kind:'hide-version',until:decision.effect.until+1}},{viewers:[f.responder.actor.subjectId]});
  await rejectUnchanged(f,f.moderator,'resolve',{...decision,reason:decision.reason+' changed'},{viewers:[f.responder.actor.subjectId]});
  assert.equal((await f.write(f.moderator,'resolve',decision,{viewers:[f.responder.actor.subjectId]})).status,200);
 }finally{await f.close();}
});

test('real controlled211d retention removes old forum records; old exact URLs cannot acquire new authors, content, deadlines or cases',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'old-locator-author');await f.login(f.responder,'new-locator-author');const actualNow=f.clock.now;f.clock.now-=211*86400;
  const p=await f.post(),q=await f.post({postId:p.postId,expectedHeadVersion:1,title:'A second independently permitted version'}),r=await f.reply(p);
  assert.equal((await f.write(f.owner,'create-post',p)).status,200);assert.equal((await f.write(f.owner,'publish-version',q)).status,200);assert.equal((await f.write(f.responder,'create-reply',r)).status,200);
  const report={schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'privacy',summary:'A historical isolated case statement.'};
  assert.equal((await f.write(f.responder,'create-report',report,{viewers:[f.moderator.actor.subjectId]})).status,200);
  const decision={schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:report.reportId,expectedReportVersion:1,kind:'resolve',resolution:'dismissed',reason:'A separately signed finite decision.',effect:null};
  assert.equal((await f.write(f.moderator,'resolve',decision,{viewers:[f.owner.actor.subjectId,f.responder.actor.subjectId]})).status,200);
  f.clock.now=actualNow;const removed=await cleanupProductV2Retention(f.db,{now:()=>actualNow,forumPolicy:f.forum.policy,endpoint:f.owner.access.endpoint});
  assert.equal(removed.removed.forumClosedReports,1);for(const table of forumBudgetTables)assert.equal((await f.db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
  const retired=await f.request(`/v2/community/posts/${p.postId}/versions/${p.versionId}`,{authorization:false});assert.equal(retired.status,404);
  for(const who of [f.owner,f.responder])await rejectUnchanged(f,who,'create-post',{...p,operationId:randomUUID(),publishedUntil:actualNow+2592000,body:'Reoccupied retired URL attempt.'});
  await rejectUnchanged(f,f.owner,'create-post',{...p,publishedUntil:actualNow+2592000});
  const expiredOriginal=await f.authorize(f.owner,'create-post',p,{expiresAt:actualNow+3600});assert.equal((await f.request('/v2/community/posts',{input:expiredOriginal})).status,403);
  const fresh=await f.post({},f.responder);assert.equal((await f.write(f.responder,'create-post',fresh)).status,200);assert.notEqual(fresh.postId,p.postId);
  const version=await f.post({postId:fresh.postId,expectedHeadVersion:1},f.responder);await rejectUnchanged(f,f.responder,'publish-version',{...version,versionId:q.versionId});assert.equal((await f.write(f.responder,'publish-version',version)).status,200);
  const reply=await f.reply(fresh,{},f.owner);await rejectUnchanged(f,f.owner,'create-reply',{...reply,replyId:r.replyId});assert.equal((await f.write(f.owner,'create-reply',reply)).status,200);
  const newReport=await f.prepare(f.owner,'create-report',{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:fresh.postId,versionId:fresh.versionId},category:'privacy',summary:'This is a distinct new case.'});
  await rejectUnchanged(f,f.owner,'create-report',{...newReport,reportId:report.reportId},{viewers:[f.moderator.actor.subjectId]});assert.equal((await f.write(f.owner,'create-report',newReport,{viewers:[f.moderator.actor.subjectId]})).status,200);
  const newDecision=await f.prepare(f.moderator,'resolve',{...decision,operationId:randomUUID(),reportId:newReport.reportId,reason:'A decision for the new exact case.'});
  await rejectUnchanged(f,f.moderator,'resolve',{...newDecision,governanceEventId:decision.governanceEventId},{viewers:[f.owner.actor.subjectId,f.responder.actor.subjectId]});assert.equal((await f.write(f.moderator,'resolve',newDecision,{viewers:[f.owner.actor.subjectId,f.responder.actor.subjectId]})).status,200);
  for(const path of [`/v2/community/posts/${p.postId}/versions/${p.versionId}`,`/v2/community/posts/${fresh.postId}/versions/${q.versionId}`,`/v2/community/replies/${r.replyId}`,`/v2/community/reports/${report.reportId}`])assert.equal((await f.request(path)).status,404,path);
  assert.equal((await f.ok(`/v2/community/posts/${fresh.postId}/versions/${fresh.versionId}`,{authorization:false})).payload.body,fresh.body);
 }finally{await f.close();}
});
