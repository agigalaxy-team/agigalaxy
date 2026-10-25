import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {PublicCommunitySource} from '../src/discovery-runtime/public-content-source.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {OperationsRecommendationService} from '../src/operations/recommendations/service.mjs';
import {OperationsAccountProfileSummary} from '../src/operations/accounts/profile-summary.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {queryProjection} from '../src/operations-agentos-query-view.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real PG and galaxy_api grants, real account/public readers, purpose recorder,
// recommendation provenance and authorization. Only upstream management and
// fixture chat transport/scanner/store are doubles. No native recommendation
// request, model, HTTP authentication or production mutation is claimed.
test('account topic analysis derives qualified normal-purpose facts and recorded recommendation categories with fresh scope and no recommendation writes',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const [a,b,c]=f.people,at=()=>new Date(f.now()*1000).toISOString(),
  admin={kind:'business-operator',operatorId:'profile-analysis-admin',endpoint:f.endpoint,role:'administrator'},reader={...admin,operatorId:'profile-analysis-reader',role:'reader'},otherReader={...reader,operatorId:'profile-analysis-only'};
 for(const actor of [admin,reader,otherReader])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.invalid',$1,'画像分析者',$3,$3)",[actor.operatorId,f.endpoint,at()]);
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),authority=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['analytics.read','recommendations.read']}),permissions=authority.permissions;
 authority.roles.set(otherReader.operatorId,'reader');
 const profileRole=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'只读正常用途画像',description:'不授推荐读取',enabled:true,permissions:['analytics.read']},{authorize:async()=>admin})).role;
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:otherReader.operatorId,roleId:profileRole.id,enabled:true},{authorize:async()=>admin});
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),source=new PublicCommunitySource({db:f.db,endpoint:f.endpoint,forum});businessAdmin.forum=forum;
 const recommendations=new OperationsRecommendationService({db:f.db,endpoint:f.endpoint,businessAdmin,permissions,source,now:f.now});
 const publish=async(person,topic,publicRead=true)=>{
  const payload=await bindForumIds('create-post','account:'+person.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:person.accountId,title:'私密测试标记不会出现在画像 '+randomUUID(),body:'PRIVATE_BODY_MARKER',links:[],topic,audience:{read:{kind:publicRead?'everyone':'accounts'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});
  await forum.publish(person,{payloadJson:JSON.stringify(payload)});return payload;
 };
 const A=await publish(b,'technology'),Self=await publish(a,'arts'),Private=await publish(a,'life',false),Legacy=await publish(a,'galaxy'),Negative=await publish(b,'learning');
 // Simulate an existing subject-only head. An account association is not
 // original authorship; this adapter only accepts the exact stored account.
 await f.db.query('UPDATE forum_posts_v1 SET account_id=NULL WHERE id=$1',[Legacy.postId]);
 const theme=(await recommendations.saveTheme(admin,{operationId:randomUUID(),expectedVersion:0,label:'工具与学习',enabled:true,mapping:{categories:['technology','learning'],tagIds:[],queryTerms:['找TOOL']},reason:'实际显式映射'},{authorize:async()=>admin})).theme;
 let nativeCalls=0;
 const discovery=new DiscoveryRuntime({db:f.db,endpoint:f.endpoint,accounts:f.accounts,source,permissions,recommendationOperations:recommendations,now:f.now,gorse:{recommend:async()=>{nativeCalls++;throw Error('not permitted in analysis');}}});
 await discovery.initialize();
 const refs=post=>({kind:'post',id:post.postId,version:post.versionId}),visitor=randomUUID();
 const record=(person,name,pageKey,extra={})=>discovery.recordUsage(person,visitor,{eventId:randomUUID(),name,pageKey,...extra});
 await record(a,'content-view','community',{content:refs(A)});await record(a,'content-click','home',{content:refs(A)});await record(a,'content-bookmark','community',{content:refs(A)});await record(a,'content-participate','community',{content:refs(A)});
 await record(a,'search','find',{query:'　找ｔｏｏｌ　'});await record(a,'search','find',{query:'RAW_PRIVATE_SEARCH_MARKER'});
 await record(b,'content-view','community',{content:refs(Negative)});
 await record(a,'content-view','community',{content:refs(Negative)});await record(a,'not-interested','home',{content:refs(Negative)});
 const plan=await recommendations.publicPlan('account:'+a.accountId),document=await source.load(refs(A));
 // Seed a real server-issued earlier public request via its existing issuer;
 // profile reads below must never call this writing path again.
 const issued=await recommendations.issue('account:'+a.accountId,'personalized',[{document,candidate:{source:'gorse-recommendation'}}],plan);
 for(const [name,pageKey]of [['content-exposure','home'],['content-click','home'],['content-bookmark','community']])await record(a,name,pageKey,{content:refs(A),recommendation:{requestId:issued.requestId}});
 await assert.rejects(record(a,'content-view','community',{content:refs(Private)}),{code:'discovery_source_unavailable'});
 await assert.rejects(record(a,'content-view','rooms',{content:refs(A)}),{code:'invalid_discovery_request'});
 await assert.rejects(record(a,'search','find',{query:'case material',body:'PRIVATE_CASE_MARKER'}),{code:'invalid_discovery_request'});
 // A corrupt legacy row with the normal outer purpose still cannot inject a
 // private module, arbitrary topic, body or another account's recommendation.
 const corruptId=randomUUID();await f.db.query(`INSERT INTO discovery_usage_events_v1(endpoint,id,account_id,visitor_id,profile_id,name,purpose,payload,created_at) VALUES($1,$2,$3,$4,$5,'search','site-usage-analytics',$6,$7)`,[f.endpoint,corruptId,a.accountId,visitor,'account:'+a.accountId,{eventId:corruptId,accountId:a.accountId,profileId:'account:'+a.accountId,name:'search',purpose:'site-usage-analytics',pageKey:'rooms',query:'PRIVATE_CHAT_MARKER',topic:'private',body:'PRIVATE_CASE_MARKER'},at()]);
 // Foreign endpoint/account metadata exists, but must fail before the reader.
 const foreign=randomUUID();await f.db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,'https://foreign.invalid','https://account.invalid',$1::text,'email',$2,$2)",[foreign,at()]);
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const service=new OperationsAccountProfileSummary({businessAdmin,discovery,now:f.now});businessAdmin.accountProfileAnalysis=service;
 const count=async table=>(await f.db.query('SELECT count(*)::int AS count FROM '+table)).rows[0].count,
  before={events:await count('discovery_usage_events_v1'),requests:await count('discovery_recommendation_requests_v1'),feedback:await count('discovery_feedback_v1')};
 let summary=await businessAdmin.accountSummary(reader,a.accountId,{days:7}),value=summary.profile;
 t.diagnostic('Real API-role summary, public sources and normal-purpose ledgers read');
 assert.equal(value.state,'partial','a rejected legacy event is excluded and not represented as complete collection');assert.equal(value.validUntil,null);assert.equal(value.period.timeZone,'Asia/Shanghai');assert.equal(summary.readExpiresAt,f.now()+30);
 const technology=value.interests.find(row=>row.key==='category:technology');assert.ok(technology);assert.deepEqual(technology.signalCounts,{views:1,clicks:2,bookmarks:2,participations:1,publicPosts:0,publicReplies:0,searches:0,notInterested:0});assert.equal(technology.method,'qualified-topic-observation-v1');assert.equal(technology.firstObservedAt,at());assert.equal(technology.lastObservedAt,at());
 assert.equal(value.interests.find(row=>row.key==='category:arts').signalCounts.publicPosts,1);
 assert.equal(value.interests.some(row=>row.key==='category:life'),false,'private authored content never becomes a profile fact');assert.equal(value.interests.some(row=>row.key==='category:galaxy'),false,'subject-only original author is not inferred from an associated account');
 assert.equal(value.interests.some(row=>row.key==='category:learning'),false,'explicit current negative item does not reinforce interest');
 assert.equal(value.needs.length,1);assert.equal(value.needs[0].key,theme.key);assert.equal(value.needs[0].signalCounts.searches,1);assert.equal(value.basis.unmappedSearches,1);
 const category=summary.recommendations.categories.find(row=>row.key==='category:technology');assert.deepEqual(category.counts,{returnedCandidates:1,exposures:1,clicks:1,bookmarks:1,participations:0,notInterested:0});
 for(const field of ['activeDays','searches','bookmarks','participation'])assert.equal(summary.usage[field],null);assert.equal(summary.predictions.participation.state,'not-analyzed');assert.equal(summary.predictions.needs.state,'not-analyzed');
 const projected=queryProjection.accountSummary({...summary,profile:{...value,privateBody:'PRIVATE_BODY_MARKER',rawProvider:{url:'PRIVATE_URL_MARKER'},interests:value.interests.map(row=>({...row,contentId:A.postId,body:'PRIVATE_CASE_MARKER',query:'RAW_PRIVATE_SEARCH_MARKER'}))}});
 assert.equal(projected.profile.needs[0].key,theme.key);assert.deepEqual(projected.recommendations.categories.find(row=>row.key==='category:technology').counts,category.counts);
 for(const marker of ['PRIVATE_BODY_MARKER','PRIVATE_CASE_MARKER','PRIVATE_CHAT_MARKER','RAW_PRIVATE_SEARCH_MARKER','PRIVATE_URL_MARKER',A.postId,Private.postId])assert(!JSON.stringify(projected).includes(marker));
 const onlyProfile=await service.get(otherReader,a.accountId);assert.equal(onlyProfile.recommendations.state,'not-authorized');assert.deepEqual(onlyProfile.recommendations.categories,[]);assert.ok(onlyProfile.profile.interests.length>0);
 const other=await service.get(reader,c.accountId);assert.equal(other.profile.state,'empty');assert.deepEqual(other.profile.interests,[]);assert.equal(other.recommendations.state,'empty');
 for(const [actor,id,code]of [[reader,foreign,'not_found'],[{...reader,endpoint:'https://foreign.invalid'},a.accountId,'business_admin_denied'],[reader,randomUUID(),'not_found']])await assert.rejects(service.get(actor,id),{code});
 // Current public-source withdrawal removes both observed interest and
 // recommendation category rather than retaining a stale inferred profile.
 const withdrawal=await bindForumIds('withdraw-post','account:'+b.accountId,{schemaVersion:1,operationId:randomUUID(),postId:A.postId,expectedHeadVersion:1,accountId:b.accountId});
 await forum.withdraw(b,'withdraw-post',{payloadJson:JSON.stringify(withdrawal)});
 summary=await businessAdmin.accountSummary(reader,a.accountId);assert.equal(summary.profile.interests.some(row=>row.key==='category:technology'),false);assert.equal(summary.recommendations.categories.some(row=>row.key==='category:technology'),false);
 t.diagnostic('Current author withdrawal invalidated profile and recommendation category');
 // No engine/source is distinct from an available empty account.
 const disconnected=await new OperationsAccountProfileSummary({businessAdmin,now:f.now}).get(reader,a.accountId);assert.equal(disconnected.profile.state,'not-connected');
 const load=source.load.bind(source);source.load=async()=>{throw new ServiceError('discovery_engine_unavailable',503);};const unavailable=await service.get(reader,a.accountId);assert.equal(unavailable.profile.state,'unavailable');assert.deepEqual(unavailable.profile.interests,[]);source.load=load;
 // Revoke the current stored grant while the source is being read; the final
 // authorization must reject the entire assembled account material.
 const assignment=(await permissions.personnel(admin)).items.find(item=>item.operatorId===reader.operatorId).assignments[0];let revoke=true;
 source.load=async(...args)=>{const result=await load(...args);if(revoke&&!args[1]?.db){revoke=false;await permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:assignment.roleId,enabled:false},{authorize:async()=>admin});}return result;};
 await assert.rejects(service.get(reader,a.accountId),{code:'operations_permission_denied'});source.load=load;
 t.diagnostic('Stored PG grant revocation rejected assembled account material');
 assert.equal(nativeCalls,0);assert.deepEqual({events:await count('discovery_usage_events_v1'),requests:await count('discovery_recommendation_requests_v1'),feedback:await count('discovery_feedback_v1')},before,'all analysis reads leave recommendation/normal-use ledgers unchanged');
});
