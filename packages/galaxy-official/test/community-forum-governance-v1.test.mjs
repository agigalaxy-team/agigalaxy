import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {defaultForumPolicy} from '../src/community-forum-policy-v1.mjs';

const event=(reportId,version,kind,extra={})=>({schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId,expectedReportVersion:version,kind,...extra});
async function initial(f){
 await f.login(f.owner,'forum-target-owner');await f.login(f.responder,'forum-reporter');
 const p=await f.post(),published=await f.write(f.owner,'create-post',p);assert.equal(published.status,200,JSON.stringify(published.body));
 const report={schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'privacy',summary:'Private reporter statement; never copied as decision reason.'};
 const submitted=await f.write(f.responder,'create-report',report,{viewers:[f.moderator.actor.subjectId]});assert.equal(submitted.status,200,JSON.stringify(submitted.body));
 return {p,report,submitted};
}
test('private report, body-free affected discovery, moderation-only real role, own decision reason and finite appeal',async()=>{
 const f=await communityForumFixture();try{
  const {p,report}=await initial(f),ids=[f.responder.actor.subjectId,f.owner.actor.subjectId];
  const config=await f.ok('/v2/community/reports/config',{who:f.moderator,input:{}});assert.equal(config.guaranteesResponse,false);
  const affected=await f.ok('/v2/community/affected-events/query',{input:{}});assert.equal(affected.items[0].reportId,report.reportId);assert.equal(JSON.stringify(affected).includes(report.summary),false);
  let view=await f.ok(`/v2/community/reports/${report.reportId}`);assert.equal(view.events.length,0);assert.equal('decisionRecipients' in view,false);
  const handler=await f.ok(`/v2/community/reports/${report.reportId}`,{who:f.moderator});assert.equal(handler.canModerate,true);assert.equal(handler.events[0].payload.summary,report.summary);
  assert.equal((await f.ok('/v2/community/reports/query',{who:f.moderator,input:{}})).items.length,1);
  const resolve=event(report.reportId,1,'resolve',{resolution:'accepted',reason:'Specific independent decision reason.',effect:{kind:'hide-version',until:f.clock.now+1200}});
  const missingNotice=await f.write(f.moderator,'resolve',resolve,{viewers:[ids[0]]});assert.equal(missingNotice.status,403);
  const decided=await f.write(f.moderator,'resolve',resolve,{viewers:ids});assert.equal(decided.status,200,JSON.stringify(decided.body));
  const decisionPermission=(await f.db.query('SELECT permission_id FROM forum_governance_events_v1 WHERE id=$1',[resolve.governanceEventId])).rows[0].permission_id;
  assert.equal((await f.ok(`/v2/community/permissions/${decisionPermission}`,{who:f.moderator})).visibility,'Private');
  assert.equal((await f.request(`/v2/community/permissions/${decisionPermission}`,{who:f.owner})).status,404);
  assert.deepEqual(Object.keys(await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).sort(),['availability','checkedAt','locator']);
  view=await f.ok(`/v2/community/reports/${report.reportId}`);assert.equal(view.canAppeal,true);assert.equal(view.events.length,1);assert.equal(view.events[0].payload.reason,resolve.reason);assert.equal(JSON.stringify(view).includes(report.summary),false);
  const appeal=event(report.reportId,2,'appeal',{summary:'Affected author requests correction.'});assert.equal((await f.write(f.owner,'appeal',appeal,{viewers:[f.moderator.actor.subjectId]})).status,200);
  const repeated=await f.write(f.owner,'appeal',{...appeal,operationId:randomUUID(),governanceEventId:randomUUID(),expectedReportVersion:3},{viewers:[f.moderator.actor.subjectId]});assert.equal(repeated.status,409);
  const dismiss=event(report.reportId,3,'resolve',{resolution:'dismissed',reason:'Independent follow-up changed the decision.',effect:null});assert.equal((await f.write(f.moderator,'resolve',dismiss,{viewers:ids})).status,200);
  assert.equal((await f.ok(`/v2/community/posts/${p.postId}`,{authorization:false})).availability,'available');
  assert.equal((await f.db.query('SELECT restricted_until FROM community_accounts')).rows.every(x=>x.restricted_until===null),true);
 }finally{await f.close();}
});

test('small narrative cap reserves necessary withdraw and three appeals; no-op fresh IDs cannot grow cases',async()=>{
 const f=await communityForumFixture({policy:{...defaultForumPolicy,maxReportEvents:4,maxAppeals:3}});try{
  const {report}=await initial(f),ids=[f.responder.actor.subjectId,f.owner.actor.subjectId];let version=1;
  for(let i=0;i<3;i++){const p=event(report.reportId,version++,'supplement',{summary:'Finite reporter clarification '+i});assert.equal((await f.write(f.responder,'supplement',p,{viewers:[f.moderator.actor.subjectId]})).status,200);}
  assert.equal((await f.write(f.responder,'supplement',event(report.reportId,version,'supplement',{summary:'Above narrative cap'}),{viewers:[f.moderator.actor.subjectId]})).status,409);
  for(let i=0;i<4;i++){
   assert.equal((await f.write(f.moderator,'resolve',event(report.reportId,version++,'resolve',{resolution:'dismissed',reason:'Finite decision '+i,effect:null}),{viewers:ids})).status,200);
   if(i<3)assert.equal((await f.write(f.owner,'appeal',event(report.reportId,version++,'appeal',{summary:'Finite appeal '+i}),{viewers:[f.moderator.actor.subjectId]})).status,200);
  }
  assert.equal((await f.write(f.owner,'appeal',event(report.reportId,version,'appeal',{summary:'Fourth appeal denied'}),{viewers:[f.moderator.actor.subjectId]})).status,409);
  const withdraw=event(report.reportId,version,'withdraw');assert.equal((await f.write(f.responder,'withdraw-report',withdraw)).status,200);
  assert.equal((await f.write(f.responder,'withdraw-report',{...withdraw,operationId:randomUUID(),governanceEventId:randomUUID(),expectedReportVersion:version+1})).status,409);
  assert.equal((await f.db.query('SELECT count(*) n FROM forum_governance_events_v1')).rows[0].n,12);
 }finally{await f.close();}
});

test('known shared Account handler is excluded and empty actual handler configuration makes no response guarantee',async()=>{
 const f=await communityForumFixture();try{
  await f.login(f.owner,'target');await f.login(f.responder,'same-account');await f.login(f.moderator,'same-account');
  const p=await f.post();assert.equal((await f.write(f.owner,'create-post',p)).status,200);
  const config=await f.ok('/v2/community/reports/config',{who:f.responder,input:{target:{kind:'post-version',postId:p.postId,versionId:p.versionId}}});assert.deepEqual(config.moderatorIds,[]);assert.equal(config.configured,false);
  const report={schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'spam',summary:'Own private statement.'};
  assert.equal((await f.write(f.responder,'create-report',report,{viewers:[f.moderator.actor.subjectId]})).status,403);
  const w=await f.write(f.responder,'create-report',report);assert.equal(w.status,200);assert.equal(w.body.handlingState,'awaiting-authorized-handler');
  assert.equal((await f.request(`/v2/community/reports/${report.reportId}`,{who:f.moderator})).status,404);
 }finally{await f.close();}
});
