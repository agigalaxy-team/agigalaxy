import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {businessAuditMetadata} from "../src/operations/audit/view.mjs";
import {OperationsSearchQualityService} from '../src/operations/search-quality/service.mjs';
import {OperationsRecommendationService} from "../src/operations/recommendations/service.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {PublicCommunitySource} from '../src/discovery-runtime/public-content-source.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {MeilisearchClient,OpenPanelClient} from '../src/discovery-runtime/native-clients.mjs';
import {createDiscoveryHttp} from '../src/discovery-runtime/http.mjs';
import {discoveryEvent} from '../src/discovery-runtime/purpose.mjs';
import {createDiscoveryClient} from '../../galaxy-web/src/features/discovery/client.mjs';
import {dispatchOperationsSearchQuality} from '../src/adapters/http/operations-search-quality-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';
import {searchQualityFixedConstraints,searchQualityRankingRules} from '../src/shared/operations-search-quality-schema.mjs';

const options=actor=>({authorize:async()=>actor});
const settings=(patch={})=>({synonyms:[{term:'摄影入门',alternatives:['摄影基础']}],rankingMode:'newest',fixedConstraints:{...searchQualityFixedConstraints},...patch});
const clean=()=>({synonyms:{},rankingRules:[...searchQualityRankingRules.relevance]});
function nativeFixture(){
 const n={settings:clean(),tasks:[],hits:[],calls:[],next:1,loseAck:false,rejectStatus:null,searches:[]};
 n.enqueue=value=>{const task={uid:n.next++,indexUid:'galaxy_public_community',type:'settingsUpdate',status:'enqueued',details:structuredClone(value)};n.tasks.push(task);return task;};
 n.complete=(id,status='succeeded',readback=true)=>{const task=n.tasks.find(row=>row.uid===id);assert.ok(task);task.status=status;if(status==='succeeded'&&readback)n.settings=structuredClone(task.details);};
 const transport=async(url,init)=>{
  const u=new URL(url),body=init.body?JSON.parse(init.body):null;n.calls.push({url:u,method:init.method,body});
  if(u.pathname==='/indexes/galaxy_public_community'&&init.method==='GET')return Response.json({uid:'galaxy_public_community'});
  if(u.pathname==='/indexes/galaxy_public_community/settings'){
   if(init.method==='GET')return Response.json(n.settings);
   if(n.rejectStatus)return Response.json({code:'synthetic_native_rejection'},{status:n.rejectStatus});
   const task=n.enqueue(body);if(n.loseAck){n.loseAck=false;throw Error('Explicit synthetic lost native ACK');}return Response.json({taskUid:task.uid},{status:202});
  }
  if(u.pathname==='/indexes/galaxy_public_community/search'){n.searches.push(body);return Response.json({hits:n.hits.slice(body.offset,body.offset+body.limit),estimatedTotalHits:999999});}
  if(u.pathname==='/tasks'){let rows=[...n.tasks].sort((a,b)=>b.uid-a.uid);const statuses=u.searchParams.get('statuses');if(statuses)rows=rows.filter(row=>statuses.split(',').includes(row.status));const limit=Number(u.searchParams.get('limit'));return Response.json({results:rows.slice(0,limit),next:rows.length>limit?rows[limit].uid:null});}
  if(/^\/tasks\/\d+$/.test(u.pathname)){const row=n.tasks.find(row=>row.uid===Number(u.pathname.split('/').at(-1)));return row?Response.json(row):Response.json({error:'not_found'},{status:404});}
  throw Error('Unexpected native fixture path '+u.pathname);
 };
 n.client=new MeilisearchClient({url:'http://meili.invalid',apiKey:'synthetic-meili-credential-'.repeat(2),fetch:transport});
 n.patches=()=>n.calls.filter(row=>row.method==='PATCH');return n;
}
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'synthetic-search-quality-admin',endpoint:f.endpoint,role:'administrator'},reader={...admin,operatorId:'synthetic-search-quality-reader',role:'reader'},roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operations.invalid',$1,'合成搜索运营人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId),now:f.now}),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),native=nativeFixture();
 const quality=new OperationsSearchQualityService({db:f.db,endpoint:f.endpoint,permissions,businessAdmin,meili:native.client,now:f.now});
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),source=new PublicCommunitySource({db:f.db,endpoint:f.endpoint,forum});
 const runtime=new DiscoveryRuntime({db:f.db,endpoint:f.endpoint,accounts:f.accounts,source,meili:native.client,searchQuality:quality,now:f.now});await runtime.initialize();
 async function grant(codes){const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'搜索权限 '+randomUUID(),description:'只按实际闭合动作',enabled:true,permissions:codes},options(admin))).role;return (await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},options(admin))).assignment;}
 async function publish(person,publicRead=true){const payload=await bindForumIds('create-post','account:'+person.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:person.accountId,title:'摄影与工具 '+randomUUID(),body:'本地真实匿名 reader 的合成正文',links:[],topic:'technology',audience:{read:{kind:publicRead?'everyone':'accounts'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});await forum.publish(person,{payloadJson:JSON.stringify(payload)});return payload;}
 const draft=(revision=0,patch={})=>({operationId:randomUUID(),expectedRevision:revision,settings:settings(),reason:'本次真实意图的合成说明',...patch});
 const command=(revision,id)=>({operationId:randomUUID(),expectedRevision:revision,versionId:id,reason:'采用已选版本'});
 const hit=async payload=>{const document=await source.load({kind:'post',id:payload.postId});return {id:document.id,kind:document.kind,sourceId:document.sourceId,version:document.indexVersion};};
 return {...f,admin,reader,roles,permissions,businessAdmin,native,quality,forum,source,runtime,grant,publish,draft,command,hit};
}
const allCodes=['search-quality.read','search-quality.configure','search-quality.publish','search-quality.restore'];

test('search configuration SQL uses real grants, immutable drafts, CAS, native task/readback and exact version restore',async t=>{
 const f=await fixture(t);await assert.rejects(f.quality.overview({...f.reader,role:'administrator',businessAuthorization:{permissions:allCodes}}),{code:'operations_permission_denied'});
 const assignment=await f.grant(allCodes);await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const initial=await f.quality.overview(f.reader);assert.equal(initial.configuration.active,null);assert.equal(initial.configuration.native.state,'available');assert.equal(initial.metrics.searches,null);assert.equal(initial.metrics.noResultRate,null);assert.equal(f.native.patches().length,0);
 const intent=f.draft(),saved=await f.quality.saveDraft(f.reader,intent,options(f.reader));assert.equal(saved.kind,'draft');assert.equal(saved.phase,'applied');assert.equal((await f.quality.saveDraft(f.reader,intent,options(f.reader))).replayed,true);assert.equal(f.native.patches().length,0);
 let current=await f.quality.overview(f.reader);assert.equal(current.configuration.revision,1);assert.equal(current.configuration.active.version,0);assert.equal(current.configuration.draft.version,1);
 assert.equal(current.configuration.draft.restorable,false);await assert.rejects(f.quality.restore(f.reader,f.command(1,current.configuration.draft.id),options(f.reader)),{code:'search_quality_version_not_applied'});assert.equal(f.native.patches().length,0);
 const baseline=current.configuration.active,apply=f.command(1,current.configuration.draft.id);
 const pending=await f.quality.apply(f.reader,apply,options(f.reader));assert.equal(pending.phase,'task-pending');assert.equal(f.native.patches().length,1);assert.equal((await f.quality.apply(f.reader,apply,options(f.reader))).replayed,true);assert.equal(f.native.patches().length,1);
 current=await f.quality.overview(f.reader);assert.equal(current.configuration.active.version,0);assert.equal(current.capabilities.canPublish,false);assert.equal(current.configuration.pending.operationId,apply.operationId);
 f.native.complete(1);assert.equal((await f.quality.operation(f.reader,apply.operationId)).phase,'applied');assert.deepEqual(await f.quality.publicPlan(),{version:1,rankingMode:'newest'});
 current=await f.quality.overview(f.reader);assert.equal(current.configuration.revision,3);
 await assert.rejects(f.quality.saveDraft(f.reader,f.draft(1),options(f.reader)),{code:'search_quality_revision_changed'});
 await assert.rejects(f.quality.saveDraft(f.reader,{...intent,reason:'改写原请求'},options(f.reader)),{code:'search_quality_operation_conflict'});
 await assert.rejects(f.quality.saveDraft(f.reader,f.draft(3,{settings:{...settings(),exclusions:{categories:['life']}}}),options(f.reader)),{code:'invalid_search_quality_request'});
 await assert.rejects(f.quality.saveDraft(f.reader,f.draft(3,{settings:settings({fixedConstraints:{...searchQualityFixedConstraints,currentSource:false}})}),options(f.reader)),{code:'invalid_search_quality_request'});
 const restore=f.command(3,baseline.id),restoring=await f.quality.restore(f.reader,restore,options(f.reader));assert.equal(restoring.phase,'task-pending');f.native.complete(2);assert.equal((await f.quality.operation(f.reader,restore.operationId)).phase,'applied');
 current=await f.quality.overview(f.reader);assert.equal(current.configuration.active.version,2);assert.equal(current.configuration.active.restoredFrom,baseline.id);assert.equal(current.configuration.active.settings.rankingMode,'relevance');
 const history=await f.quality.history(f.reader,{limit:1});assert.equal(history.items.length,1);assert.ok(history.nextAfter);assert.equal(history.versions.some(row=>row.id===baseline.id),true);
 const audit=(await f.db.query("SELECT * FROM business_admin_audit_v1 WHERE action LIKE 'search-quality.%' ORDER BY sequence")).rows;assert.equal(audit.length,3);assert.ok(audit.every(row=>row.operator_role==='reader'));assert.equal(JSON.stringify(audit).includes(intent.reason),false);assert.deepEqual(businessAuditMetadata(audit[0]).selection,{version:1});
 for(const statement of ["UPDATE operations_search_quality_versions_v1 SET settings='{}'::jsonb","UPDATE operations_search_quality_operations_v1 SET input='{}'::jsonb","UPDATE operations_search_quality_operations_v1 SET operator_id='replacement'","DELETE FROM operations_search_quality_versions_v1","DELETE FROM discovery_search_requests_v1"])await assert.rejects(f.db.query(statement),{code:'42501'});
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:assignment.roleId,enabled:false},options(f.admin));
 await assert.rejects(f.quality.apply(f.reader,apply,options(f.reader)),{code:'operations_permission_denied'});
 await f.db.exec('RESET ROLE');
});

test('native ACK loss is reconciled without another PATCH, while failed or ambiguous tasks never pretend applied',async t=>{
 const f=await fixture(t);const saved=await f.quality.saveDraft(f.admin,f.draft(),options(f.admin)),intent=f.command(1,saved.versionId);f.native.loseAck=true;
 const pending=await f.quality.apply(f.admin,intent,options(f.admin));assert.equal(pending.phase,'task-pending');assert.equal(f.native.patches().length,1);f.native.complete(1);assert.equal((await f.quality.operation(f.admin,intent.operationId)).phase,'applied');assert.equal(f.native.patches().length,1);
 const second=await f.quality.saveDraft(f.admin,f.draft(3,{settings:settings({rankingMode:'relevance'})}),options(f.admin));f.native.rejectStatus=400;
 const rejected=await f.quality.apply(f.admin,f.command(4,second.versionId),options(f.admin));assert.equal(rejected.phase,'failed');assert.equal((await f.quality.overview(f.admin)).configuration.pending,null);f.native.rejectStatus=null;
 let identityChecks=0;const before=f.native.patches().length;await assert.rejects(f.quality.apply(f.admin,f.command(6,second.versionId),{authorize:async()=>{identityChecks++;return identityChecks<5?f.admin:{...f.admin,operatorId:f.reader.operatorId};}}),{code:'business_admin_denied'});assert.equal(f.native.patches().length,before);
 const now=(await f.quality.overview(f.admin)).configuration.revision,next=f.command(now,second.versionId),original=f.native.client.submitSettings.bind(f.native.client);
 f.native.client.submitSettings=async value=>{f.native.enqueue(value);f.native.enqueue(value);throw Object.assign(Error('lost ambiguous ACK'),{code:'discovery_engine_unavailable'});};
 const ambiguous=await f.quality.apply(f.admin,next,options(f.admin));assert.equal(ambiguous.phase,'result-unknown');assert.equal((await f.quality.operation(f.admin,next.operationId)).phase,'result-unknown');assert.equal((await f.quality.overview(f.admin)).configuration.active.version,1);f.native.client.submitSettings=original;
 await assert.rejects(f.quality.saveDraft(f.admin,f.draft(now+1),options(f.admin)),{code:'search_quality_operation_pending'});
});

test('actual anonymous reader binds search result states and positions, rejects foreign or stale references, and does not measure selected AI reads',async t=>{
 const f=await fixture(t),[a,b]=f.people,A=await f.publish(a),privatePost=await f.publish(a,false),visitor=randomUUID(),hit=await f.hit(A);
 f.native.hits=[{id:'post_'+privatePost.postId,version:randomUUID()},hit,{...hit,id:'post_'+randomUUID()}];
 const page=await f.runtime.search({query:'摄影',limit:2},{usageIdentity:{actor:a,visitorId:visitor}});assert.equal(page.items.length,1);assert.equal(page.search.resultState,'has-results');assert.equal(page.items[0].search.position,1);
 const content={kind:'post',id:A.postId,version:A.versionId},query={eventId:randomUUID(),name:'search',pageKey:'find',query:'摄影',search:{requestId:page.search.requestId}};
 const recorded=await f.runtime.recordUsage(a,visitor,query);assert.equal(recorded.eventId,page.search.requestId);assert.equal((await f.runtime.recordUsage(a,visitor,{...query,eventId:randomUUID()})).replayed,true);
 await f.runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'search-click',pageKey:'find',content,search:{requestId:page.search.requestId}});
 await assert.rejects(f.runtime.recordUsage(b,visitor,{eventId:randomUUID(),name:'search-click',pageKey:'find',content,search:{requestId:page.search.requestId}}),{code:'discovery_search_reference_invalid'});
 await assert.rejects(f.runtime.recordUsage(a,visitor,{...query,query:'另一个词'}),{code:'discovery_search_reference_invalid'});
 assert.throws(()=>discoveryEvent({...query,search:{...query.search,position:999,configurationVersion:99}}),{code:'invalid_discovery_request'});
 const before=(await f.db.query('SELECT count(*)::integer AS count FROM discovery_search_requests_v1')).rows[0].count;await f.runtime.searchSelected({query:'摄影',limit:2},[{kind:'post',id:A.postId}]);assert.equal((await f.db.query('SELECT count(*)::integer AS count FROM discovery_search_requests_v1')).rows[0].count,before);
 f.native.hits=Array(6).fill({id:'post_'+privatePost.postId,version:randomUUID()});const limited=await f.runtime.search({query:'候选未扫完',limit:2},{usageIdentity:{actor:a,visitorId:visitor}});assert.deepEqual(limited.items,[]);assert.equal(limited.search.resultState,'scan-limited');assert.equal(limited.nextAfter,6);await f.runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'search',pageKey:'find',query:limited.query,search:{requestId:limited.search.requestId}});
 f.native.hits=[];const empty=await f.runtime.search({query:'确实空页',limit:2},{usageIdentity:{actor:a,visitorId:visitor}});assert.equal(empty.search.resultState,'no-results');await f.runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'search',pageKey:'find',query:empty.query,search:{requestId:empty.search.requestId}});
 await f.runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'search',pageKey:'find',query:'旧未归属'});await f.runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'search-click',pageKey:'find',content});
 f.advance(1);const facts=await f.quality.overview(f.admin);assert.equal(facts.queries.items.find(row=>row.label==='候选未扫完').noResultRate,null);assert.equal(facts.queries.items.find(row=>row.label==='确实空页').noResultRate,1);assert.equal(facts.queries.items.find(row=>row.label==='旧未归属').clicks,null);assert.ok(facts.queries.items.find(row=>row.label==='旧未归属').issueCodes.includes('unmeasured'));
 f.advance(3600);await assert.rejects(f.runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'search-click',pageKey:'find',content,search:{requestId:page.search.requestId}}),{code:'discovery_source_unavailable'});
});

test('shared public collectors attach only the latest successful source click and native charts retain exact ids and unknown values',async t=>{
 const f=await fixture(t),[a,b]=f.people,A=await f.publish(a),visitor=randomUUID(),hit=await f.hit(A);f.native.hits=[hit];let current=a;const sent=[];
 const fetcher=async(url,init)=>{const u=new URL(url);
  if(u.pathname==='/v1/account/session')return Response.json({state:'signed-in',galaxyAuthorization:false,account:{id:current.accountId,displayName:null,email:null,emailVerified:true},linkedIds:[],nextAfter:null,csrfToken:'synthetic-account-csrf',expiresAt:Math.floor(Date.now()/1000)+3600});
  if(u.pathname==='/v1/discovery/config')return Response.json({csrfToken:'synthetic-discovery-csrf'});
  if(u.pathname==='/v1/discovery/search'){assert.equal(init.headers['X-Galaxy-Account-ID'],current.accountId);return Response.json(await f.runtime.search({query:u.searchParams.get('q'),limit:Number(u.searchParams.get('limit')),after:Number(u.searchParams.get('after'))},{usageIdentity:{actor:current,visitorId:visitor}}));}
  const event=JSON.parse(init.body);sent.push(event);return Response.json(await f.runtime.recordUsage(current,visitor,event),{status:202});
 };
 const one=createDiscoveryClient({endpoint:f.endpoint,websiteOrigin:'https://galaxy.invalid',fetcher}),two=createDiscoveryClient({endpoint:f.endpoint,websiteOrigin:'https://galaxy.invalid',fetcher}),page=await one.search({query:'摄影',limit:2}),content={kind:'post',id:A.postId,version:A.versionId};
 await one.record({name:'search',pageKey:'find',query:'摄影',search:{requestId:page.search.requestId}});
 await one.record({name:'search-click',pageKey:'find',content,search:{requestId:page.search.requestId}});
 await two.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:a.accountId});assert.deepEqual(sent.at(-1).search,{requestId:page.search.requestId});assert.equal(sent.at(-1).recommendation,undefined);
 current=b;await two.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:b.accountId});assert.equal(sent.at(-1).search,undefined);current=a;
 await one.record({name:'content-click',pageKey:'find',content});await two.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:a.accountId});assert.equal(sent.at(-1).search,undefined);
 const recommendation=new OperationsRecommendationService({db:f.db,endpoint:f.endpoint,permissions:f.permissions,businessAdmin:f.businessAdmin,source:f.source,now:f.now}),document=await f.source.load({kind:'post',id:A.postId});f.runtime.recommendationOperations=recommendation;
 const proof=await recommendation.issue('account:'+a.accountId,'personalized',[{document,candidate:{source:'gorse-recommendation'}}],await recommendation.publicPlan('account:'+a.accountId));
 await one.record({name:'content-click',pageKey:'home',content,recommendation:{requestId:proof.requestId}});await two.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:a.accountId});assert.deepEqual(sent.at(-1).recommendation,{requestId:proof.requestId});assert.equal(sent.at(-1).search,undefined);
 f.advance(1);const facts=await f.quality.overview(f.admin,{limit:1}),row=facts.queries.items[0];assert.equal(row.searches,1);assert.equal(row.measuredSearches,1);assert.equal(row.clicks,1);assert.equal(row.clickedSearches,1);assert.equal(row.followUps,1);assert.equal(row.clickRate,1);
 const requests=[];let series=[];const panel=new OpenPanelClient({url:'http://openpanel.invalid',projectId:randomUUID(),clientId:'w'.repeat(36),clientSecret:'s'.repeat(40),readClientId:'r'.repeat(36),readClientSecret:'t'.repeat(40),fetch:async(url,init)=>{requests.push({url:new URL(url),init});return Response.json({series});}});
 const period=facts.period,empty=await panel.searchQualityReport({startDate:period.from,endDate:period.to});assert.equal(empty.metrics.searches,null);assert.equal(empty.trend.availability,'not-collected');
 const defs=JSON.parse(requests.at(-1).url.searchParams.get('series'));assert.deepEqual(defs.map(row=>row.id),['galaxy-searches','galaxy-no-results','galaxy-clicks']);assert.equal(defs[1].name,'search');assert.ok(defs[1].filters.some(filter=>filter.name==='properties.galaxy_search_result'&&filter.value[0]==='no-results'));assert.equal(requests.at(-1).init.headers['openpanel-client-id'],'r'.repeat(36));
 const date=period.to.slice(0,10);series=[{event:{id:'galaxy-no-results',name:'search'},metrics:{sum:0},data:[{date,count:0}]},{event:{id:'galaxy-searches',name:'search'},metrics:{sum:4},data:[{date,count:4}]}];
 const actual=await panel.searchQualityReport({startDate:period.from,endDate:period.to});assert.deepEqual(actual.metrics,{searches:4,noResults:0,clicks:null});assert.deepEqual(actual.trend.items,[{date,searches:4,noResults:0,clicks:null}]);
 const event=(await f.db.query("SELECT payload FROM discovery_usage_events_v1 WHERE name='search-click' AND payload->'search' IS NOT NULL LIMIT 1")).rows[0].payload;await panel.track(event);const properties=JSON.parse(requests.at(-1).init.body).payload.properties;assert.equal(properties.galaxy_search_request,page.search.requestId);assert.equal(properties.galaxy_search_position,1);assert.equal(properties.galaxy_search_version,'none');
});

test('search-quality HTTP and proxy close exact parameters, fresh CSRF writes and signed public query identity',async()=>{
 const endpoint='https://official.invalid',admin='https://admin.invalid',base='/v1/operations/search-quality',actor={kind:'business-operator',operatorId:'synthetic',endpoint},calls=[],response={setHeader:()=>{}};
 const service={overview:async(_,input)=>{calls.push(input);return{};},history:async()=>({}),operation:async(_,id)=>({operationId:id}),saveDraft:async(value,input,options)=>{assert.equal((await options.authorize()).operatorId,value.operatorId);return {operationId:input.operationId};}};
 const authorizeOperator=async(request,options)=>{calls.push({authorization:options});if(options.write&&request.headers['x-galaxy-operator-csrf']!=='synthetic')throw Object.assign(Error('csrf'),{code:'operations_csrf_invalid'});return actor;};
 const invoke=async(path,{method='GET',csrf='synthetic',input}={})=>{const request=Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]);Object.assign(request,{method,url:path,headers:{'content-type':'application/json',origin:admin,'x-galaxy-operator-csrf':csrf}});return dispatchOperationsSearchQuality({operationsSearchQuality:service,authorizeOperator,request,response,requestId:'synthetic',url:requestUrl(request,endpoint,[admin]),send:()=>{}});};
 const headers=new Headers({origin:admin,'sec-fetch-site':'same-origin'}),valid=base+'/overview?days=30&issue=unmeasured&query='+encodeURIComponent('摄影');
 assert.equal(operationsReadPath(valid),true);assert.equal(operationsProxyPolicy({url:admin+valid,method:'GET',headers,publicOrigin:admin}).allowed,true);assert.equal(await invoke(valid),true);assert.deepEqual(calls.find(row=>row.days),{days:30,issue:'unmeasured',query:'摄影'});
 const id=randomUUID();assert.equal(await invoke(base+'/operations/'+id),true);
 for(const path of [base+'/overview?days=7&days=30',base+'/overview?accountId='+id,base+'/history?query=raw',base+'/operations/'+id+'?taskId=5',base+'/apply?version=5']){assert.equal(operationsReadPath(path),false);assert.equal(operationsProxyPolicy({url:admin+path,method:path.includes('/apply')?'POST':'GET',headers,publicOrigin:admin}).allowed,false);await assert.rejects(invoke(path,{method:path.includes('/apply')?'POST':'GET'}));}
 const input={operationId:randomUUID()};await invoke(base+'/draft',{method:'POST',input});await assert.rejects(invoke(base+'/draft',{method:'POST',input,csrf:'wrong'}),{code:'operations_csrf_invalid'});await assert.rejects(invoke(base+'/__proto__'),{code:'not_found'});
 assert.ok(calls.some(row=>row.authorization?.action==='search-quality.configure'&&row.authorization.write));assert.equal(operationsProxyPolicy({url:admin+base+'/apply',method:'POST',headers:new Headers({origin:'https://foreign.invalid'}),publicOrigin:admin}).allowed,false);
 const http=createDiscoveryHttp({websiteOrigin:'https://galaxy.invalid',visitorSecret:'synthetic-visitor-secret-'.repeat(2),secureCookies:false}),accountId=randomUUID(),request={method:'GET',url:'/v1/discovery/search?q='+encodeURIComponent('摄影'),headers:{'x-galaxy-account-id':accountId}},out={headers:{},getHeader(name){return this.headers[name];},setHeader(name,value){this.headers[name]=value;}};
 let context;await http.dispatch({request,response:out,url:new URL(request.url,endpoint),requestId:'synthetic',officialAccounts:{actionActor:async(_,options)=>{assert.equal(options.write,false);return{kind:'official-account',accountId,endpoint};}},discovery:{search:async(input,options)=>{context={input,options};return{items:[]};}},send:()=>{}});assert.equal(context.options.usageIdentity.actor.accountId,accountId);assert.ok(context.options.usageIdentity.visitorId);assert.equal(context.input.query,'摄影');
});

