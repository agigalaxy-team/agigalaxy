import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {forumWriteSpec} from '../src/shared/community-forum-v1-schema.mjs';
import {digest} from '../src/shared/digest.mjs';
import {cleanupForumWithin,minimizeForumDeletionWithin} from '../src/operations/community-forum-retention-v1.mjs';
import {productV2DeletionTargets} from '../src/infrastructure/lifecycle-registry-v2.mjs';

async function accountBrowser(f,name){
 const cookies=new Map();
 const accept=response=>{for(const item of response.headers.getSetCookie()){const pair=item.split(';')[0];cookies.set(pair.split('=')[0],pair);}};
 const cookie=()=>[...cookies.values()].join('; ');
 f.issuer.setAccount(name);
 const started=await fetch(f.origin+'/v1/account/login',{redirect:'manual'});accept(started);assert.equal(started.status,303);
 const returned=await f.issuer.authorize(started.headers.get('location'));
 const callback=await fetch(f.origin+returned.pathname+returned.search,{redirect:'manual',headers:{Cookie:cookie()}});accept(callback);assert.equal(callback.status,303);
 const session=await (await fetch(f.origin+'/v1/account/session',{headers:{Cookie:cookie(),Origin:f.website}})).json();
 assert.equal(session.state,'signed-in');assert.ok(session.account.id);
 async function request(path,{input,method=input===undefined?'GET':'POST',headers={}}={}){
  const response=await fetch(f.origin+path,{method,headers:{Cookie:cookie(),Origin:f.website,'X-Galaxy-Account-ID':session.account.id,
   'X-Galaxy-Account-CSRF':session.csrfToken,...(input===undefined?{}:{'Content-Type':'application/json'}),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
  return {status:response.status,body:await response.json()};
 }
 async function write(kind,input){const payload=await bindForumIds(kind,'account:'+session.account.id,{...input,accountId:session.account.id}),payloadJson=JSON.stringify(payload);
  const path=forumWriteSpec(kind,payload).path;
  return {payload,payloadJson,...await request(path,{input:{payloadJson}})};
 }
 return {session,request,write};
}

test('real website account without a local ID publishes, replies, revises and manages its own content with exact account authority',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const before=Number((await f.db.query('SELECT count(*) n FROM subjects')).rows[0].n),owner=await accountBrowser(f,'website-author'),other=await accountBrowser(f,'website-replier');
  assert.deepEqual(owner.session.linkedIds,[]);assert.equal(Number((await f.db.query('SELECT count(*) n FROM subjects')).rows[0].n),before);
  const created=await owner.write('create-post',await f.post());assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.subjectId,null);
  const view=await f.ok('/v2/community/posts/'+created.payload.postId,{authorization:false});
  assert.equal(view.authorId,null);assert.equal(view.authorAccountId,owner.session.account.id);assert.equal(view.authorizationEvidence.kind,'official-account');assert.equal(Object.hasOwn(view.authorizationEvidence,'signatureEnvelope'),false);
  const retry=await owner.request('/v2/community/posts',{input:{payloadJson:created.payloadJson}});assert.equal(retry.status,200);
  const quota=await owner.request('/v2/community/quotas');assert.equal(quota.body.accountId,owner.session.account.id);assert.equal(quota.body.quotas.find(row=>row.category==='post').used,1);
  assert.equal((await owner.request('/v2/community/posts/'+created.payload.postId+'/owned')).status,200);
  assert.equal((await other.request('/v2/community/posts/'+created.payload.postId+'/owned')).status,404);
  assert.equal((await owner.request('/v2/community/permissions/'+created.body.permissionId)).body.authorizationKind,'official-account');
  const receipt=await owner.request('/v2/community/receipt',{input:{operationId:created.payload.operationId,payloadHash:digest(created.payloadJson)}});assert.equal(receipt.body.status,'acknowledged');
  const reply=await other.write('create-reply',await f.reply(created.payload));assert.equal(reply.status,200,JSON.stringify(reply.body));
  const next=await owner.write('publish-version',await f.post({postId:created.payload.postId,expectedHeadVersion:1,body:'Updated by the same real website account.'}));assert.equal(next.status,200,JSON.stringify(next.body));
  assert.equal((await f.ok('/v2/community/posts/'+created.payload.postId+'/versions/'+created.payload.versionId,{authorization:false})).payload.body,created.payload.body);
  const forbidden=await other.write('withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:created.payload.postId,expectedHeadVersion:2});assert.equal(forbidden.status,404);
  const noCsrf=await owner.request('/v2/community/posts',{input:{payloadJson:created.payloadJson},headers:{'X-Galaxy-Account-CSRF':'x'.repeat(43)}});assert.equal(noCsrf.status,403);
  assert.equal((await owner.request('/v2/community/quotas',{headers:{'X-Galaxy-Account-ID':other.session.account.id}})).body.error,'official_account_changed');
  assert.equal((await owner.request('/v2/community/quotas',{headers:{Authorization:'Bearer invalid'}})).status,401,'invalid ID authorization never falls back to a valid account Cookie');
  assert.equal(Number((await f.db.query('SELECT count(*) n FROM consents')).rows[0].n),0);
  const event=(await f.db.query('SELECT * FROM forum_events_v1 WHERE id=$1',[created.payload.operationId])).rows[0];assert.equal(event.actor_kind,'official-account');assert.equal(event.subject_id,null);assert.equal(event.consent_id,null);assert.ok(event.http_request_id);
  const withdrawn=await owner.write('withdraw-post',{schemaVersion:1,operationId:randomUUID(),postId:created.payload.postId,expectedHeadVersion:2});assert.equal(withdrawn.status,200);
  assert.equal((await f.ok('/v2/community/replies/'+reply.payload.replyId,{authorization:false})).parentAvailability,'withdrawn');
 }finally{await f.close();}
});

test('new M:N ID publications require an explicitly signed target; account management preserves each historical author',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const one=await accountBrowser(f,'first-account'),two=await accountBrowser(f,'second-account');
  await f.login(f.owner,'first-account');await f.login(f.owner,'second-account');
  const options=await f.ok('/v2/community/quotas');assert.equal(options.reason,'account_selection_required');assert.equal(options.availableAccounts.length,2);assert.equal(options.accountId,null);
  assert.equal((await f.write(f.owner,'create-post',await f.post())).body.error,'account_selection_required');
  const p=await f.post({accountId:two.session.account.id}),accepted=await f.write(f.owner,'create-post',p);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal((await f.db.query('SELECT account_id FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0].account_id,two.session.account.id);
  assert.equal((await one.request('/v2/community/posts/'+p.postId+'/owned')).status,404);
  const revision=await two.write('publish-version',await f.post({postId:p.postId,expectedHeadVersion:1,title:'Managed by target account'}));assert.equal(revision.status,200,JSON.stringify(revision.body));
  const original=await f.ok('/v2/community/posts/'+p.postId+'/versions/'+p.versionId,{authorization:false}),latest=await f.ok('/v2/community/posts/'+p.postId,{authorization:false});
  assert.equal(original.authorId,f.owner.actor.subjectId);assert.equal(original.authorAccountId,two.session.account.id);assert.equal(latest.authorId,null);assert.equal(latest.authorAccountId,two.session.account.id);
  const mismatch=await f.authorize(f.owner,'create-post',await f.post({accountId:two.session.account.id}));
  const denied=await fetch(f.origin+'/v2/community/posts',{method:'POST',headers:{Authorization:'Bearer '+f.owner.credential,'Content-Type':'application/json','X-Galaxy-Account-ID':one.session.account.id},body:JSON.stringify(mismatch)});
  assert.equal((await denied.json()).error,'forum_account_target_mismatch');
  const tampered={...accepted.input,payloadJson:JSON.stringify({...p,accountId:one.session.account.id})};assert.equal((await f.request('/v2/community/posts',{input:tampered})).status,409);
 }finally{await f.close();}
});

test('account-only content survives ordinary retention and removal of its last local ID association',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await accountBrowser(f,'independent-account'),post=await owner.write('create-post',await f.post());assert.equal(post.status,200);
  await f.login(f.owner,'independent-account');
  await cleanupForumWithin(f.db,f.clock.now,{policy:f.forum.policy,endpoint:f.owner.access.endpoint});
  assert.equal((await f.ok('/v2/community/posts/'+post.payload.postId,{authorization:false})).availability,'available');
  await minimizeForumDeletionWithin(f.db,{subjectId:f.owner.actor.subjectId,requestId:randomUUID(),at:f.clock.now,retainedUntil:f.clock.now+86400});
  await f.db.query('DELETE FROM community_account_links WHERE subject_id=$1',[f.owner.actor.subjectId]);
  assert.equal(productV2DeletionTargets.community_accounts,'false');assert.equal(productV2DeletionTargets.forum_daily_usage_v1,'false');
  assert.equal((await owner.request('/v2/community/posts/'+post.payload.postId+'/owned')).status,200);
  assert.equal((await f.ok('/v2/community/posts/'+post.payload.postId,{authorization:false})).authorAccountId,owner.session.account.id);
  f.clock.now+=f.forum.policy.maxPermissionSeconds+1;
  await cleanupForumWithin(f.db,f.clock.now,{policy:f.forum.policy,endpoint:f.owner.access.endpoint});
  const erased=(await f.db.query('SELECT subject_id,account_id FROM lifecycle_erasure_records WHERE object_key=$1',[post.payload.operationId])).rows[0];
  assert.equal(erased.subject_id,null);assert.equal(erased.account_id,owner.session.account.id,'account-only erasure has an account audit, not a fabricated ID');
 }finally{await f.close();}
});

test('read and participation conditions apply to search, detail, replies and current notifications; widening a post does not widen another author reply',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await accountBrowser(f,'audience-owner'),reader=await accountBrowser(f,'audience-reader'),outside=await accountBrowser(f,'audience-outsider'),
   audience={read:{kind:'selected-accounts',accountIds:[reader.session.account.id]},participate:{kind:'selected-accounts',accountIds:[reader.session.account.id]}};
  const created=await owner.write('create-post',await f.post({audience,title:'Restricted research discussion'}));assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal((await f.ok('/v2/community/posts/'+created.payload.postId,{authorization:false})).availability,'unavailable');
  assert.equal((await reader.request('/v2/community/posts/'+created.payload.postId)).body.availability,'available');
  assert.equal((await outside.request('/v2/community/posts/'+created.payload.postId)).body.availability,'unavailable');
  assert.equal((await reader.request('/v2/community/posts/query',{input:{query:'Restricted research'}})).body.items.length,1);
  assert.equal((await outside.request('/v2/community/posts/query',{input:{query:'Restricted research'}})).body.items.length,0);
  const refused=await outside.write('create-reply',await f.reply(created.payload));assert.equal(refused.status,403);
  const reply=await reader.write('create-reply',await f.reply(created.payload));assert.equal(reply.status,200,JSON.stringify(reply.body));
  const notice=await owner.request('/v2/community/notifications/query',{input:{}});assert.equal(notice.body.items[0].replyId,reply.payload.replyId);
  assert.equal((await owner.request('/v2/community/notifications/read',{input:{replyId:reply.payload.replyId}})).status,200);
  assert.equal((await owner.request('/v2/community/notifications/query',{input:{unreadOnly:true}})).body.items.length,0);
  const revised=await owner.write('publish-version',await f.post({postId:created.payload.postId,expectedHeadVersion:1,title:'Now public',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}}}));assert.equal(revised.status,200,JSON.stringify(revised.body));
  assert.equal((await f.ok('/v2/community/posts/'+created.payload.postId,{authorization:false})).availability,'available');
  assert.equal((await f.ok('/v2/community/replies/'+reply.payload.replyId,{authorization:false})).availability,'unavailable');
  assert.equal((await outside.request('/v2/community/replies/'+reply.payload.replyId)).body.availability,'unavailable');
  assert.equal((await reader.request('/v2/community/replies/'+reply.payload.replyId)).body.availability,'available');
  const hidden=await owner.write('withdraw-version',{schemaVersion:1,operationId:randomUUID(),postId:created.payload.postId,versionId:created.payload.versionId,expectedHeadVersion:2});assert.equal(hidden.status,200);
  assert.equal((await owner.request('/v2/community/notifications/query',{input:{}})).body.items.length,0,'notification contains no stale title or body after the exact source is withdrawn');
 }finally{await f.close();}
});

test('member sections persist with a maintainer, enforce current rules, and keep operator classification separate from member maintenance',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await accountBrowser(f,'section-maintainer'),member=await accountBrowser(f,'section-participant'),outside=await accountBrowser(f,'section-reader'),
   audience={read:{kind:'accounts'},participate:{kind:'selected-accounts',accountIds:[member.session.account.id]}};
  const section=await owner.write('create-section',{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),expectedVersion:0,title:'城市步行与观察',theme:'长期交流步行观察与公共空间',description:'成员维护的独立讨论版块。',audience});
  assert.equal(section.status,200,JSON.stringify(section.body));const id=section.payload.sectionId;
  assert.equal((await owner.request('/v2/community/sections/'+id)).body.canMaintain,true);
  assert.equal((await member.request('/v2/community/sections/'+id)).body.canParticipate,true);
  assert.equal((await outside.request('/v2/community/sections/'+id)).body.canParticipate,false);
  assert.equal((await f.request('/v2/community/sections/'+id,{authorization:false})).status,404);
  assert.equal((await owner.request('/v2/community/sections/query',{input:{managed:true}})).body.items[0].sectionId,id);
  const forbidden=await outside.write('create-post',await f.post({sectionId:id}));assert.equal(forbidden.status,403);
  const created=await member.write('create-post',await f.post({sectionId:id,title:'步行记录的观察方法'}));assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal((await outside.request('/v2/community/posts/query',{input:{sectionId:id}})).body.items[0].sectionId,id);
  const classified=await f.write(f.moderator,'classify-section',{schemaVersion:1,operationId:randomUUID(),sectionId:id,expectedVersion:1,category:'life'});assert.equal(classified.status,200,JSON.stringify(classified.body));
  const current=(await owner.request('/v2/community/sections/'+id)).body;assert.equal(current.category,'life');assert.equal(current.version,2);
  const stolen=await outside.write('update-section',{...section.payload,operationId:randomUUID(),expectedVersion:2,title:'Not the maintainer'});assert.equal(stolen.status,404);
  const archived=await owner.write('update-section',{...section.payload,operationId:randomUUID(),expectedVersion:2,state:'archived'});assert.equal(archived.status,200);
  const kept=(await owner.request('/v2/community/sections/'+id)).body;assert.equal(kept.category,'life');assert.equal(kept.state,'archived');
  assert.equal((await member.write('create-reply',await f.reply(created.payload))).status,403);
  assert.equal((await member.request('/v2/community/posts/'+created.payload.postId)).body.availability,'available','archiving a section does not erase its existing allowed posts');
  const ordinary=await outside.write('create-post',await f.post());assert.equal(ordinary.status,200,'an ordinary post needs no member section');
 }finally{await f.close();}
});

test('ordinary Cookie accounts can privately report, supplement, withdraw and appeal; signed decisions notify account parties without exposing report narratives',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await accountBrowser(f,'reported-account'),reporter=await accountBrowser(f,'reporting-account'),outside=await accountBrowser(f,'unrelated-account'),
   post=await owner.write('create-post',await f.post()),target={kind:'post-version',postId:post.payload.postId,versionId:post.payload.versionId};
  const config=await reporter.request('/v2/community/reports/config',{input:{target}});assert.deepEqual(config.body.moderatorIds,[f.moderator.actor.subjectId]);
  const report=await reporter.write('create-report',{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target,category:'privacy',summary:'Private original account statement.'});
  assert.equal(report.status,200,JSON.stringify(report.body));const id=report.payload.reportId;
  assert.equal((await owner.request('/v2/community/reports/'+id)).body.events.length,0);
  assert.equal((await outside.request('/v2/community/reports/'+id)).status,404);
  assert.equal((await owner.request('/v2/community/affected-events/query',{input:{}})).body.items[0].reportId,id);
  const supplement=await reporter.write('supplement',{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:id,expectedReportVersion:1,kind:'supplement',summary:'Private extra account information.'});assert.equal(supplement.status,200,JSON.stringify(supplement.body));
  const handler=await f.ok('/v2/community/reports/'+id,{who:f.moderator});assert.equal(handler.canModerate,true);assert.deepEqual(new Set(handler.decisionAccountRecipients),new Set([owner.session.account.id,reporter.session.account.id]));
  const decision={schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:id,expectedReportVersion:2,kind:'resolve',resolution:'dismissed',reason:'A separate signed decision for the affected parties.',effect:null};
  assert.equal((await f.write(f.moderator,'resolve',decision)).body.error,'forum_decision_notice_required');
  decision.accountViewers=handler.decisionAccountRecipients;assert.equal((await f.write(f.moderator,'resolve',decision)).status,200);
  const affected=(await owner.request('/v2/community/reports/'+id)).body;assert.equal(affected.canAppeal,true);assert.equal(affected.events.length,1);assert.equal(affected.events[0].payload.reason,decision.reason);assert.equal(JSON.stringify(affected).includes(report.payload.summary),false);
  const appeal=await owner.write('appeal',{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:id,expectedReportVersion:3,kind:'appeal',summary:'Affected account appeal, privately sent to the handler.'});assert.equal(appeal.status,200,JSON.stringify(appeal.body));
  const receipt=await owner.request('/v2/community/receipt',{input:{operationId:appeal.payload.operationId,payloadHash:digest(appeal.payloadJson)}});assert.equal(receipt.body.status,'acknowledged');
  assert.equal((await reporter.request('/v2/community/receipt',{input:{operationId:appeal.payload.operationId,payloadHash:digest(appeal.payloadJson)}})).body.status,'absent');
  const row=(await f.db.query('SELECT subject_id,account_id,actor_kind FROM forum_governance_events_v1 WHERE id=$1',[appeal.payload.governanceEventId])).rows[0];assert.equal(row.subject_id,null);assert.equal(row.account_id,owner.session.account.id);assert.equal(row.actor_kind,'official-account');
  const withdrawal=await reporter.write('withdraw-report',{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:id,expectedReportVersion:4,kind:'withdraw'});assert.equal(withdrawal.status,200,JSON.stringify(withdrawal.body));
  assert.equal((await reporter.request('/v2/community/reports/'+id)).body.state,'withdrawn');
 }finally{await f.close();}
});

test('an ID associated with a Cookie reporter retains reporter access but cannot act as the report handler',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const owner=await accountBrowser(f,'cookie-target'),reporter=await accountBrowser(f,'cookie-reporter');await f.login(f.moderator,'cookie-reporter');
  const post=await owner.write('create-post',await f.post()),target={kind:'post-version',postId:post.payload.postId,versionId:post.payload.versionId},config=await reporter.request('/v2/community/reports/config',{input:{target}});
  assert.deepEqual(config.body.moderatorIds,[]);assert.equal(config.body.guaranteesResponse,false);
  const report=await reporter.write('create-report',{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target,category:'other',summary:'No independent configured handler is available.'});assert.equal(report.status,200,JSON.stringify(report.body));
   assert.equal(report.body.handlingState,'awaiting-authorized-handler');
   const linkedReporter=await f.request('/v2/community/reports/'+report.payload.reportId,{who:f.moderator});
   assert.equal(linkedReporter.status,200,JSON.stringify(linkedReporter.body));
   assert.equal(linkedReporter.body.actionAccountId,reporter.session.account.id);
   assert.equal(linkedReporter.body.canModerate,false);
   assert.equal(Object.hasOwn(linkedReporter.body,'decisionRecipients'),false);
   assert.equal(Object.hasOwn(linkedReporter.body,'decisionAccountRecipients'),false);
   assert.equal(linkedReporter.body.events.length,1);
   assert.equal(linkedReporter.body.events[0].authorId,null);
   assert.equal(linkedReporter.body.events[0].authorAccountId,reporter.session.account.id);
   assert.equal(linkedReporter.body.events[0].payload.summary,report.payload.summary);
   const affected=await owner.request('/v2/community/reports/'+report.payload.reportId);
   assert.equal(affected.status,200);assert.equal(affected.body.events.length,0);
   assert.equal(JSON.stringify(affected.body).includes(report.payload.summary),false);
   const decision=await f.write(f.moderator,'resolve',{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:report.payload.reportId,
    expectedReportVersion:1,kind:'resolve',resolution:'dismissed',reason:'An associated reporter cannot handle its own report.',effect:null});
   assert.equal(decision.status,403);assert.equal(decision.body.error,'forum_independent_handler_required');
 }finally{await f.close();}
});

test('existing object ownership selects its current account across M:N links without changing authors or choosing a target for new replies',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const one=await accountBrowser(f,'context-person'),two=await accountBrowser(f,'context-organization');
  await f.login(f.owner,'context-person');await f.login(f.owner,'context-organization');await f.login(f.responder,'context-organization');
  await f.db.query('UPDATE official_account_profiles_v1 SET display_name=NULL,subject_type=NULL WHERE account_id=$1',[one.session.account.id]);
  await f.db.query("UPDATE official_account_profiles_v1 SET display_name='城市观察小组',subject_type='organization' WHERE account_id=$1",[two.session.account.id]);
  const created=await two.write('create-post',await f.post({title:'已有账户的步行观察'}));assert.equal(created.status,200,JSON.stringify(created.body));
  const owned=await f.ok('/v2/community/posts/'+created.payload.postId+'/owned');assert.equal(owned.authorAccountId,two.session.account.id);assert.equal(owned.authorId,null);
  const quota=await f.ok('/v2/community/quotas?postId='+created.payload.postId);
  assert.equal(quota.accountId,two.session.account.id);assert.equal(quota.accountSelectionRequired,false);
  assert.equal(quota.currentAccount.displayName,'城市观察小组');assert.equal(quota.currentAccount.subjectType,'organization');
  assert.equal(quota.availableAccounts.find(item=>item.id===one.session.account.id).displayName,null);
  assert.equal(quota.publication.maxPublishedUntil,quota.publication.checkedAt+f.forum.policy.maxPermissionSeconds);
  const ownList=await f.ok('/v2/community/posts/owned',{input:{order:'published'}});assert.ok(ownList.items.some(item=>item.locator.postId===created.payload.postId));
  const revision=await f.write(f.owner,'publish-version',await f.post({postId:created.payload.postId,expectedHeadVersion:1,title:'沿用原账户修改'}));
  assert.equal(revision.status,200,JSON.stringify(revision.body));assert.equal(revision.body.accountId,two.session.account.id);
  assert.equal((await f.ok('/v2/community/posts/'+created.payload.postId+'/versions/'+created.payload.versionId,{authorization:false})).authorId,null);
  assert.equal((await f.ok('/v2/community/posts/'+created.payload.postId,{authorization:false})).authorId,f.owner.actor.subjectId);
  const wrong=await f.write(f.owner,'publish-version',await f.post({postId:created.payload.postId,expectedHeadVersion:2,accountId:one.session.account.id}));assert.equal(wrong.status,404);
  const ambiguous=await f.write(f.owner,'create-reply',await f.reply(revision.body,{},f.owner));assert.equal(ambiguous.body.error,'account_selection_required','a parent author is not the new reply author');
  const reply=await f.write(f.owner,'create-reply',await f.reply({...created.payload,versionId:revision.body.versionId},{accountId:two.session.account.id},f.owner));assert.equal(reply.status,200,JSON.stringify(reply.body));
  assert.equal((await f.ok('/v2/community/quotas?replyId='+reply.body.replyId)).accountId,two.session.account.id);
  const withdrawn=await f.write(f.responder,'withdraw-reply',{schemaVersion:1,operationId:randomUUID(),replyId:reply.body.replyId,expectedRevision:1});assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.body));
  const audience={read:{kind:'accounts'},participate:{kind:'accounts'}},section=await two.write('create-section',{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),expectedVersion:0,title:'日常观察',theme:'步行与公共空间',description:'',state:'archived',audience});assert.equal(section.status,200,JSON.stringify(section.body));
  assert.equal((await f.ok('/v2/community/sections/'+section.body.sectionId)).canMaintain,true);
  assert.ok((await f.ok('/v2/community/sections/query',{input:{managed:true}})).items.some(item=>item.sectionId===section.body.sectionId));
  assert.equal((await f.ok('/v2/community/quotas?sectionId='+section.body.sectionId)).accountId,two.session.account.id);
  const sectionPayload={...section.payload,operationId:randomUUID(),expectedVersion:1,title:'更新日常观察'};delete sectionPayload.accountId;delete sectionPayload.state;
  const maintained=await f.write(f.owner,'update-section',sectionPayload);assert.equal(maintained.status,200,JSON.stringify(maintained.body));
  assert.equal((await f.ok('/v2/community/sections/'+section.body.sectionId)).state,'archived');
  const choices=await f.ok('/v2/account-archives/accounts',{input:{}});assert.equal(choices.accounts.find(item=>item.accountId===two.session.account.id).displayName,'城市观察小组');
  const outside=await accountBrowser(f,'context-outside'),outsidePost=await outside.write('create-post',await f.post());assert.equal(outsidePost.status,200);
  const report=await two.write('create-report',{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),target:{kind:'post-version',postId:outsidePost.payload.postId,versionId:outsidePost.payload.versionId},category:'other',summary:'已有账户的私有举报。'});assert.equal(report.status,200,JSON.stringify(report.body));
  const reportView=await f.ok('/v2/community/reports/'+report.body.reportId);assert.equal(reportView.actionAccountId,two.session.account.id);assert.equal(reportView.canSupplement,true);
  const supplement=await f.write(f.owner,'supplement',{schemaVersion:1,operationId:randomUUID(),governanceEventId:randomUUID(),reportId:report.body.reportId,expectedReportVersion:1,kind:'supplement',summary:'沿原举报账户补充。',accountId:reportView.actionAccountId});assert.equal(supplement.status,200,JSON.stringify(supplement.body));
  assert.ok((await two.request('/v2/community/reports/'+report.body.reportId)).body.events.some(event=>event.payload.summary==='沿原举报账户补充。'));
  await f.db.query(`UPDATE external_identity_links SET revoked_at=$3 WHERE subject_id=$1 AND id IN
   (SELECT identity_link_id FROM community_account_links WHERE account_id=$2)`,[f.owner.actor.subjectId,two.session.account.id,new Date(f.clock.now*1000).toISOString()]);
  const stale=await f.write(f.owner,'publish-version',await f.post({postId:created.payload.postId,expectedHeadVersion:2}));assert.equal(stale.body.error,'account_target_unavailable');
  assert.equal((await two.request('/v2/community/posts/'+created.payload.postId+'/owned')).status,200,'independent Cookie ownership remains');
 }finally{await f.close();}
});

test('audience account lookup returns only opted-in public profiles and never exposes private account metadata through an exact UUID',async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const visible=await accountBrowser(f,'public-profile-choice'),hidden=await accountBrowser(f,'private-profile-choice');
  await f.db.query("UPDATE official_account_profiles_v1 SET display_name='可读账户',subject_type='person',query_enabled=true WHERE account_id=$1",[visible.session.account.id]);
  await f.db.query("UPDATE official_account_profiles_v1 SET display_name='私有账户',subject_type='organization',query_enabled=false WHERE account_id=$1",[hidden.session.account.id]);
  const found=await f.ok('/v2/community/accounts/query',{authorization:false,input:{query:'可读'}});assert.equal(found.items.length,1);assert.equal(found.items[0].displayName,'可读账户');assert.equal(found.items[0].accountId,visible.session.account.id);
  assert.deepEqual((await f.ok('/v2/community/accounts/query',{authorization:false,input:{query:hidden.session.account.id}})).items,[]);
  assert.equal(JSON.stringify(found).includes('external_subject'),false);assert.equal(JSON.stringify(found).includes('email'),false);
 }finally{await f.close();}
});
