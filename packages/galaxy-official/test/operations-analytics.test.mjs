import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {CommunityForumGovernanceV1} from "../src/community/community-forum-governance-v1.mjs";
import {OperationsPermissionsService} from '../src/operations/permissions/index.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsCommunityService} from "../src/operations/community/service.mjs";
import {dispatchBusinessAdmin} from '../src/adapters/http/business-admin-http.mjs';
import {operationsAnalyticsPeriod,publicForumActivityWithin} from "../src/operations/analytics/service.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';

const everyone={read:{kind:'everyone'},participate:{kind:'accounts'}};
const accountsOnly={read:{kind:'accounts'},participate:{kind:'accounts'}};

test('account and workbench summaries count exact current public facts, keep other uses unknown and preserve source permissions',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),
  governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),
  admin={kind:'business-operator',operatorId:'analytics-synthetic-admin',role:'administrator',endpoint:f.endpoint},
  reader={...admin,operatorId:'analytics-synthetic-reader',role:'reader'};
 // Current management eligibility is explicit; reader data rights come from
 // committed business roles rather than its supplied role label.
 const roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]),
  operatorAuthorization=async actor=>roles.get(actor.operatorId)??null,
  permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization,now:f.now}),
  service=new BusinessAdminService({db:f.db,endpoint:f.endpoint,forum,permissions,operatorAuthorization,now:f.now});
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.org',$1,'合成运营人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成汇总只读角色',description:'当前公开来源统计合同',enabled:true,
  permissions:['accounts.read','analytics.read','workbench.read','content.read','audit.read']},{authorize:async()=>admin})).role;
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin});
 const community=new OperationsCommunityService({businessAdmin:service,forum,governance,now:f.now});
 await f.db.query("UPDATE official_account_profiles_v1 SET subject_type='organization' WHERE account_id=$1",[f.people[1].accountId]);
 await f.db.query('UPDATE official_account_profiles_v1 SET subject_type=NULL WHERE account_id=$1',[f.people[2].accountId]);
 const foreignId=randomUUID();
 await f.db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
  VALUES($1,'https://different.example.org','https://login.example.org','another-service','external-account',$2,$2)`,[foreignId,new Date(f.now()*1000)]);
 const restriction={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+600)*1000).toISOString(),reason:'合成的短期业务限制'};
 await service.restrict(admin,f.people[2].accountId,restriction);
 const first=await service.list(reader,{limit:1});assert.equal(first.items.length,1);
 const directory=await service.directorySummary(reader,{days:28});
 assert.deepEqual(directory.totals,{accounts:3,person:1,agent:0,organization:1,unknown:1,restricted:1,active:null});
 assert.equal(directory.coverage,'business-service-accounts');
 assert.equal((await service.list(reader,{subjectType:'organization',restriction:'normal'})).items[0].accountId,f.people[1].accountId);
 assert.equal((await service.list(reader,{subjectType:'unknown',restriction:'restricted'})).items[0].accountId,f.people[2].accountId);
 await assert.rejects(service.list(reader,{subjectType:'invented'}),{code:'invalid_business_admin_request'});
 await assert.rejects(service.accountSummary(f.people[0],f.people[0].accountId),{code:'business_admin_denied'});
 await assert.rejects(service.directorySummary(reader,{days:30}),{code:'invalid_business_admin_request'});
 await service.releaseRestriction(admin,f.people[2].accountId,{operationId:randomUUID(),expectedRevision:1,reason:'合成限制已完成复核'});

 async function post(owner=f.people[0],extra={}){
  const input={schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),accountId:owner.accountId,
   expectedHeadVersion:0,title:'有真实发表时间的合成帖子',body:'公开来源正文不应回传到汇总',links:[],publishedUntil:f.now()+2592000,audience:everyone,...extra};
  const payload=await bindForumIds(input.expectedHeadVersion?'publish-version':'create-post','account:'+owner.accountId,input);
  await forum.publish(owner,{payloadJson:JSON.stringify(payload)});return payload;
 }
 const original=await post(),organizationPost=await post(f.people[1]);
 await post(f.people[0],{audience:accountsOnly,title:'PRIVATE_ANALYTICS_MARKER',body:'PRIVATE_ANALYTICS_MARKER'});
 const section=await bindForumIds('create-section','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),accountId:f.people[0].accountId,
  expectedVersion:0,title:'受限合成版块',theme:'受限范围',description:'不能用全站公开权限绕过版块范围',audience:accountsOnly});
 await forum.sections.save(f.people[0],{payloadJson:JSON.stringify(section)});
 await post(f.people[0],{sectionId:section.sectionId});
 const reply=await bindForumIds('create-reply','account:'+f.people[1].accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),accountId:f.people[1].accountId,
  postId:original.postId,postVersionId:original.versionId,expectedRevision:0,body:'真实公开回复',replyTo:null,publishedUntil:f.now()+2592000,audience:everyone});
 await forum.createReply(f.people[1],{payloadJson:JSON.stringify(reply)});
 const before=await service.accountSummary(reader,f.people[1].accountId,{days:7});
 assert.equal(before.usage.publicContributions,2);assert.equal(before.usage.activeDays,null);assert.equal(before.usage.searches,null);assert.equal(before.usage.bookmarks,null);
 assert.equal(before.usage.dailyActivity.reduce((n,row)=>n+row.count,0),2);
 assert.equal(before.profile.state,'not-analyzed');assert.deepEqual(before.profile.interests,[]);assert.equal(before.predictions.participation.state,'not-analyzed');
 assert.deepEqual(before.recommendations.categories,[]);assert.equal(JSON.stringify(before).includes('PRIVATE_ANALYTICS_MARKER'),false);
 const activity=await publicForumActivityWithin(f.db,{forum,endpoint:f.endpoint,now:f.now()});
 assert.deepEqual(activity.totals,{posts:2,replies:1});assert.equal(activity.daily.length,7);
 const originalDate=activity.daily.find(row=>row.posts===2).date;
 f.advance(86400);
 await post(f.people[0],{postId:original.postId,expectedHeadVersion:1});
 const revised=await publicForumActivityWithin(f.db,{forum,endpoint:f.endpoint,now:f.now()});
 assert.deepEqual(revised.totals,{posts:2,replies:1});assert.equal(revised.daily.find(row=>row.date===originalDate).posts,2);
 assert.deepEqual(revised.daily.at(-1),{date:operationsAnalyticsPeriod(f.now()).dates.at(-1),posts:0,replies:0},'revision is not a new first publication');

 const report=await bindForumIds('create-report','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),accountId:f.people[0].accountId,
  target:{kind:'post-version',postId:organizationPost.postId,versionId:organizationPost.versionId},category:'other',summary:'CASE_EVIDENCE_ANALYTICS_MARKER'});
 await governance.report(f.people[0],{payloadJson:JSON.stringify(report)});
 await community.resolve(admin,report.reportId,{operationId:randomUUID(),expectedVersion:1,resolution:'accepted',summary:'CASE_DECISION_ANALYTICS_MARKER',hideUntil:f.now()+60});
 const hidden=await service.accountSummary(reader,f.people[1].accountId);assert.equal(hidden.usage.publicContributions,1);
 const summary=await community.summary(reader);
 assert.equal(summary.analytics.available,false);assert.equal(summary.analytics.visitors,null);assert.equal(summary.analytics.activeAccounts,null);assert.equal(summary.analytics.returnRate,null);
 assert.deepEqual(summary.businessActivity.totals,{posts:1,replies:1});assert.equal(summary.ai,null);assert.equal(summary.availability.ai,'not-authorized');
 assert.equal(summary.recentOperations.some(row=>row.action==='community-report-resolve'),true);
 assert.equal(summary.recentOperations.some(row=>row.action==='user-read'),false);
 assert.equal(JSON.stringify(summary).includes('CASE_EVIDENCE_ANALYTICS_MARKER'),false);assert.equal(JSON.stringify(summary).includes('CASE_DECISION_ANALYTICS_MARKER'),false);
 f.advance(61);assert.equal((await service.accountSummary(reader,f.people[1].accountId)).usage.publicContributions,2,'expired operational hiding restores only currently eligible public sources');

 let response,authorizationCount=0;
 const authorizeOperator=async()=>{authorizationCount++;return reader;};
 const request={method:'GET',headers:{}};
 assert.equal(await dispatchBusinessAdmin({businessAdmin:service,authorizeOperator,request,url:new URL('/v1/operations/users/summary?days=7',f.endpoint),send:(_,value)=>{response=value;}}),true);
 assert.equal(response.totals.accounts,3);
 await dispatchBusinessAdmin({businessAdmin:service,authorizeOperator,request,url:new URL('/v1/operations/users/'+f.people[1].accountId+'/summary?days=28',f.endpoint),send:(_,value)=>{response=value;}});
 assert.equal(response.days,28);assert.equal(response.usage.publicContributions,2);assert.equal(authorizationCount,2);
 await assert.rejects(dispatchBusinessAdmin({businessAdmin:service,authorizeOperator,request,url:new URL('/v1/operations/users/summary?days=7&days=28',f.endpoint),send:()=>{}}),{code:'invalid_business_admin_request'});
 const unauthorized=Object.assign(Readable.from([]),{method:'GET',headers:{}});
 await assert.rejects(dispatchBusinessAdmin({businessAdmin:service,authorizeOperator:async()=>f.people[0],request:unauthorized,url:new URL('/v1/operations/users/summary',f.endpoint),send:()=>{}}),{code:'business_admin_denied'});
});

test('missing public readers remain unknown and calendar windows follow Asia/Shanghai',async()=>{
 const value=await publicForumActivityWithin(null,{forum:null,endpoint:'https://example.org',now:2000000000});
 assert.equal(value.available,false);assert.deepEqual(value.totals,{posts:null,replies:null});assert.deepEqual(value.daily,[]);
 const period=operationsAnalyticsPeriod(Date.parse('2026-10-22T00:30:00+08:00')/1000,7);
 assert.equal(period.period.from,'2026-10-15T16:00:00.000Z');assert.equal(period.dates.at(-1),'2026-10-22');
});
