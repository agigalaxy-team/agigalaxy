import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {businessAuditMetadata} from "../src/operations/audit/view.mjs";
import {OperationsRecommendationService} from '../src/operations/recommendations/service.mjs';
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {PublicCommunitySource} from '../src/discovery-runtime/public-content-source.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {OpenPanelClient} from '../src/discovery-runtime/native-clients.mjs';
import {discoveryEvent} from '../src/discovery-runtime/purpose.mjs';
import {createDiscoveryClient} from '../../galaxy-web/src/features/discovery/client.mjs';
import {dispatchOperationsRecommendation} from '../src/adapters/http/operations-recommendation-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

const nullMetrics={exposures:null,clicks:null,bookmarks:null,notInterested:null};
const controls={avoidRepetition:false,avoidConcentration:false};
const authorize=actor=>({authorize:async()=>actor});
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'synthetic-recommendation-admin',endpoint:f.endpoint,role:'administrator'},reader={...admin,operatorId:'synthetic-recommendation-reader',role:'reader'};
 const roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.invalid',$1,'合成推荐运营人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId),now:f.now});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now});
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),source=new PublicCommunitySource({db:f.db,endpoint:f.endpoint,forum});
 const operations=new OperationsRecommendationService({db:f.db,endpoint:f.endpoint,permissions,businessAdmin,source,now:f.now});
 const policy=(patch={})=>({operationId:randomUUID(),expectedVersion:0,enabled:true,themeKey:'category:life',direction:'increase',controls,reason:'本次真实操作意图的合成说明',...patch});
 const grant=async codes=>{const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'推荐业务权限 '+randomUUID(),description:'限定本批实际业务动作',enabled:true,permissions:codes},authorize(admin))).role;
  const assignment=(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},authorize(admin))).assignment;return {role,assignment};};
 async function publish(person,topic='technology',publicRead=true){
  const payload=await bindForumIds('create-post','account:'+person.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:person.accountId,
   title:'当前公开来源 '+randomUUID(),body:'实际原匿名reader读取的合成内容',links:[],topic,audience:{read:{kind:publicRead?'everyone':'accounts'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});
  await forum.publish(person,{payloadJson:JSON.stringify(payload)});return payload;
 }
 return {...f,admin,reader,roles,permissions,businessAdmin,forum,source,operations,policy,grant,publish};
}

test('recommendation SQL policies use fresh closed grants, CAS, original receipts and immutable scoped history under the API role',async t=>{
 const f=await fixture(t),tagId=randomUUID(),foreignTag=randomUUID();
 await f.db.query(`INSERT INTO operations_forum_tags_v1(id,endpoint,name,normalized_name,revision,enabled,created_at,updated_at) VALUES($1,$2,'显式标签','显式标签',1,true,$3,$3),($4,'https://foreign.invalid','其它端点','其它端点',1,true,$3,$3)`,[tagId,f.endpoint,new Date(f.now()*1000),foreignTag]);
 await assert.rejects(f.operations.overview({...f.reader,role:'administrator',businessAuthorization:{permissions:['recommendations.read','recommendations.configure']}}),{code:'operations_permission_denied'});
 const {assignment}=await f.grant(['recommendations.read','recommendations.configure']);await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const initial=await f.operations.overview(f.reader);assert.equal(initial.policy.version,0);assert.equal(initial.policy.enabled,false);assert.deepEqual(initial.metrics,nullMetrics);assert.equal(initial.trend.availability,'not-connected');
 assert.equal(initial.catalog.items.filter(item=>item.kind==='category').length,6);assert.equal(initial.catalog.items.some(item=>item.id===foreignTag),false);
 const input=f.policy(),receipt=await f.operations.savePolicy(f.reader,input,authorize(f.reader));assert.equal(receipt.policy.version,1);assert.equal((await f.operations.savePolicy(f.reader,input,authorize(f.reader))).replayed,true);
 await assert.rejects(f.operations.savePolicy(f.reader,{...input,reason:'改变原请求'},authorize(f.reader)),{code:'recommendation_operation_conflict'});
 await assert.rejects(f.operations.savePolicy(f.reader,f.policy(),authorize(f.reader)),{code:'recommendation_policy_changed'});
 await assert.rejects(f.operations.savePolicy(f.reader,f.policy({expectedVersion:1}),authorize(f.admin)),{code:'business_admin_denied'});
 await assert.rejects(f.operations.savePolicy(f.reader,f.policy({expectedVersion:1})),{code:'operations_authorization_unavailable'});
 const themeInput={operationId:randomUUID(),expectedVersion:0,label:'明确的跨分类映射',enabled:true,mapping:{categories:['technology','life'],tagIds:[tagId],queryTerms:['找TOOL','找ｔｏｏｌ']},reason:'明确维护的映射，不是模型推断'};
 const made=await f.operations.saveTheme(f.reader,themeInput,authorize(f.reader));assert.deepEqual(made.theme.mapping.queryTerms,['找tool']);assert.equal(made.theme.key,'theme:'+made.theme.id);
 await assert.rejects(f.operations.saveTheme(f.reader,{...themeInput,operationId:randomUUID(),mapping:{...themeInput.mapping,tagIds:[foreignTag]}},authorize(f.reader)),{code:'recommendation_mapping_unavailable'});
 await f.db.query('UPDATE operations_forum_tags_v1 SET enabled=false WHERE id=$1',[tagId]);
 const stopped=await f.operations.saveTheme(f.reader,{...themeInput,operationId:randomUUID(),themeId:made.theme.id,expectedVersion:1,enabled:false,label:'仍保留原映射'},authorize(f.reader));assert.equal(stopped.theme.version,2);assert.deepEqual(stopped.theme.mapping.tagIds,[tagId]);
 const filtered=await f.operations.overview(f.reader,{days:7,query:'明确'});assert.equal(filtered.catalog.items.some(item=>item.kind==='category'),false);assert.equal(filtered.mappingCatalog.items.some(item=>item.id===tagId),true);
 const history=await f.operations.history(f.reader,{limit:1});assert.equal(history.items.length,1);assert.ok(history.nextAfter);assert.deepEqual(history.items[0].changes.enabled,{before:true,after:false});
 const audit=(await f.db.query("SELECT * FROM business_admin_audit_v1 WHERE action='recommendations.configure' ORDER BY sequence")).rows;
 assert.equal(audit.length,3);assert.equal(audit.every(row=>row.operator_role==='reader'),true);assert.equal(JSON.stringify(audit).includes(themeInput.reason),false);assert.equal(JSON.stringify(audit).includes(themeInput.label),false);
 assert.deepEqual(businessAuditMetadata({...audit[0],selection:{...audit[0].selection,reason:'must not escape'},result:{...audit[0].result,body:'must not escape'}}).selection,{kind:'policy',version:1});
 await assert.rejects(f.db.query("UPDATE operations_recommendation_events_v1 SET reason='rewrite'"),{code:'42501'});
 await assert.rejects(f.db.query("UPDATE operations_recommendation_themes_v1 SET endpoint='https://foreign.invalid'"),{code:'42501'});
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:assignment.roleId,enabled:false},authorize(f.admin));
 await assert.rejects(f.operations.savePolicy(f.reader,input,authorize(f.reader)),{code:'operations_permission_denied'});
 await f.db.exec('RESET ROLE');await migrate(f.db,{roles:['worker']});await f.db.exec('SET ROLE galaxy_evidence_worker');
 await assert.rejects(f.db.query('SELECT * FROM operations_recommendation_policy_v1'),{code:'42501'});await f.db.exec('RESET ROLE');
});

test('actual public reader, Gorse order and server-issued positions survive policy control, latest mode, exclusion and live source loss',async t=>{
 const f=await fixture(t),[a,b]=f.people,A=await f.publish(a),B=await f.publish(a),C=await f.publish(b,'life'),privatePost=await f.publish(a,'life',false);
 const keys=[privatePost,A,B,C].map(post=>'post_'+post.postId),latest=[C,B,A].map(post=>'post_'+post.postId),calls=[];
 const runtime=new DiscoveryRuntime({db:f.db,endpoint:f.endpoint,accounts:f.accounts,source:f.source,now:f.now,recommendationOperations:f.operations,
  gorse:{recommend:async({mode,offset,limit})=>{calls.push({mode,offset,limit});return(mode==='latest'?latest:keys).slice(offset,offset+limit).map(id=>({id,source:mode==='latest'?'gorse-latest':'gorse-recommendation'}));}}});
 await runtime.initialize();const visitor=randomUUID();
 const original=await runtime.recommend(a,visitor,{limit:2});assert.deepEqual(original.items.map(item=>item.id),[A.postId,B.postId]);assert.equal(original.recommendation.policyVersion,null);
 const changed=await f.operations.savePolicy(f.admin,f.policy(),authorize(f.admin));
 const biased=await runtime.recommend(a,visitor,{limit:2});assert.deepEqual(biased.items.map(item=>item.id),[A.postId,C.postId]);assert.equal(biased.recommendation.policyVersion,changed.policy.version);assert.equal(biased.items.some(item=>item.id===privatePost.postId),false);
 const item=biased.items[0],content={kind:item.kind,id:item.id,version:item.version},proof={requestId:item.recommendation.requestId};
 for(const entry of biased.items)await runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'content-exposure',pageKey:'home',content:{kind:entry.kind,id:entry.id,version:entry.version},recommendation:{requestId:entry.recommendation.requestId}});
 await assert.rejects(runtime.recordUsage(b,visitor,{eventId:randomUUID(),name:'content-click',pageKey:'home',content,recommendation:proof}),{code:'discovery_recommendation_reference_invalid'});
 assert.throws(()=>discoveryEvent({eventId:randomUUID(),name:'content-click',pageKey:'home',content,recommendation:{...proof,policyVersion:999,position:1}}),{code:'invalid_discovery_request'});
 const kept=await f.operations.savePolicy(f.admin,f.policy({expectedVersion:1,direction:'keep'}),authorize(f.admin));
 assert.deepEqual((await runtime.recommend(a,visitor,{limit:2})).items.map(item=>item.id),[A.postId,B.postId]);
 await f.operations.savePolicy(f.admin,f.policy({expectedVersion:kept.policy.version,direction:'keep',controls:{avoidRepetition:true,avoidConcentration:true}}),authorize(f.admin));
 assert.deepEqual((await runtime.recommend(a,visitor,{limit:2})).items.map(item=>item.id),[B.postId,C.postId]);
 const newest=await runtime.recommend(a,visitor,{mode:'latest',limit:2});assert.deepEqual(newest.items.map(item=>item.id),[C.postId,B.postId]);assert.equal(newest.recommendation.policyVersion,null);
 await runtime.recordUsage(a,visitor,{eventId:randomUUID(),name:'not-interested',pageKey:'home',content:{kind:'post',id:C.postId,version:C.versionId},recommendation:{requestId:biased.recommendation.requestId}});
 assert.equal((await runtime.recommend(a,visitor,{limit:3})).items.some(item=>item.id===C.postId),false);
 const input={eventId:randomUUID(),name:'content-click',pageKey:'home',content,recommendation:proof};
 await runtime.recordUsage(a,visitor,input);assert.equal((await runtime.recordUsage(a,visitor,input)).replayed,true);
 const saved=(await f.db.query('SELECT payload FROM discovery_usage_events_v1 WHERE id=$1',[input.eventId])).rows[0].payload;
 assert.equal(saved.recommendation.policyVersion,1);assert.equal(saved.recommendation.position,1);assert.equal(saved.recommendation.placement,'home-public-recommendations');assert.equal(saved.recommendation.candidateSource,'gorse-recommendation');
 assert.equal(saved.recommendation.themeKeys.includes('category:technology'),true);
 await f.operations.savePolicy(f.admin,f.policy({expectedVersion:3,enabled:false,controls:{avoidRepetition:true,avoidConcentration:true}}),authorize(f.admin));
 assert.deepEqual((await runtime.recommend(a,visitor,{limit:2})).items.map(item=>item.id),[A.postId,B.postId]);
 const load=f.source.load.bind(f.source);let hideA=true;f.source.load=async(reference,options)=>{const value=await load(reference,options);if(!options?.db&&hideA&&reference.id===A.postId){hideA=false;await f.db.query(`INSERT INTO operations_content_visibility_v1(endpoint,target_kind,target_id,revision,hidden_until,operation_id,updated_at) VALUES($1,'forum-post',$2,1,$3,$4,$5)`,[f.endpoint,A.postId,new Date((f.now()+3600)*1000),randomUUID(),new Date(f.now()*1000)]);}return value;};
 const fresh=await runtime.recommend(a,visitor,{limit:2});assert.equal(fresh.items.some(item=>item.id===A.postId),false);assert.equal(fresh.items.some(item=>item.id===C.postId),false);
 f.advance(3601);assert.deepEqual((await runtime.recommend(a,visitor,{limit:2})).items,[]);
 await assert.rejects(runtime.recordUsage(a,visitor,{...input,eventId:randomUUID()}),{code:'discovery_source_unavailable'});
 assert.ok(calls.every(call=>call.offset+call.limit<=100));
});

test('native recommendation aggregation and qualified theme facts keep unknowns while clicked receipts remain bound across collectors and identities',async t=>{
 const f=await fixture(t),[a,b]=f.people,A=await f.publish(a),_B=await f.publish(b,'life'),visitor=randomUUID(),requests=[];let series=[];
 const panel=new OpenPanelClient({url:'http://openpanel.invalid',projectId:randomUUID(),clientId:'w'.repeat(36),clientSecret:'s'.repeat(40),readClientId:'r'.repeat(36),readClientSecret:'t'.repeat(40),fetch:async(url,options)=>{requests.push({url:new URL(url),options});return Response.json({series});}});f.operations.openpanel=panel;
 const made=await f.operations.saveTheme(f.admin,{operationId:randomUUID(),expectedVersion:0,label:'显式跨类用途',enabled:true,mapping:{categories:['technology','life'],tagIds:[],queryTerms:['找工具']},reason:'本地明确映射'},authorize(f.admin));
 const runtime=new DiscoveryRuntime({db:f.db,endpoint:f.endpoint,accounts:f.accounts,source:f.source,now:f.now,recommendationOperations:f.operations,gorse:{recommend:async()=>[{id:'post_'+A.postId,source:'gorse-recommendation'}]}});await runtime.initialize();
 const page=await runtime.recommend(a,visitor,{limit:1}),item=page.items[0],content={kind:item.kind,id:item.id,version:item.version};
 const record=(name,pageKey,extra={})=>runtime.recordUsage(a,visitor,{eventId:randomUUID(),name,pageKey,...extra});
 await record('search','find',{query:'　找工具　'});await record('content-view','community',{content});await record('pageview','account');await record('content-exposure','home',{content});
 let current=a;const events=[];
 const fetcher=async(url,options)=>{const path=new URL(url).pathname;
  if(path==='/v1/account/session')return Response.json({state:'signed-in',galaxyAuthorization:false,account:{id:current.accountId,displayName:null,email:null,emailVerified:true},linkedIds:[],nextAfter:null,csrfToken:'synthetic-account-csrf',expiresAt:Math.floor(Date.now()/1000)+3600});
  if(path==='/v1/discovery/config')return Response.json({csrfToken:'synthetic-discovery-csrf'});
  const event=JSON.parse(options.body);events.push(event);return Response.json(await runtime.recordUsage(current,visitor,event),{status:202});
 };
 const first=createDiscoveryClient({endpoint:f.endpoint,websiteOrigin:'https://galaxy.invalid',fetcher}),second=createDiscoveryClient({endpoint:f.endpoint,websiteOrigin:'https://galaxy.invalid',fetcher});
 await first.record({name:'content-exposure',pageKey:'home',content,recommendation:{requestId:item.recommendation.requestId}});
 await first.record({name:'content-click',pageKey:'home',content,recommendation:{requestId:item.recommendation.requestId}});
 await second.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:a.accountId});assert.deepEqual(events.at(-1).recommendation,{requestId:item.recommendation.requestId});
 current=b;await second.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:b.accountId});assert.equal(events.at(-1).recommendation,undefined);
 await assert.rejects(second.record({name:'content-bookmark',pageKey:'community',content},{expectedAccountId:a.accountId}),{code:'discovery_account_changed'});
 await assert.rejects(first.record({name:'content-click',pageKey:'home',content,recommendation:{requestId:item.recommendation.requestId,policyVersion:999}}));
 // The report uses [from,to) at whole-second precision, so advance beyond the
 // accepted event second instead of changing the production window bounds.
 f.advance(1);
 const overview=await f.operations.overview(f.admin,{days:30}),theme=overview.topics.items.find(value=>value.key===made.theme.key);
 assert.equal(theme.supply,2);assert.equal(theme.demand,5);assert.equal(theme.exposures,1);assert.equal(theme.clicks,1);assert.equal(theme.bookmarks,1);assert.equal(overview.metrics.exposures,null);assert.deepEqual(overview.trend.items,[]);
 const chart=requests.at(-1);assert.equal(chart.url.pathname,'/export/charts');assert.equal(chart.options.headers['openpanel-client-id'],'r'.repeat(36));
 const definitions=JSON.parse(chart.url.searchParams.get('series'));assert.deepEqual(definitions.map(row=>row.name),['content-exposure','content-click','content-bookmark','not-interested']);assert.ok(definitions.every(row=>row.segment==='event'&&row.filters.some(filter=>filter.name==='properties.galaxy_placement'&&filter.value[0]==='home-public-recommendations')));
 const date=new Date(f.now()*1000).toISOString().slice(0,10);series=[{event:{name:'content-exposure'},metrics:{sum:0},data:[{date:date+' 00:00:00',count:0}]},{event:{name:'content-click'},metrics:{sum:2},data:[{date,count:2}]}];
 const native=await panel.recommendationReport({startDate:overview.period.from,endDate:overview.period.to});assert.deepEqual(native.metrics,{exposures:0,clicks:2,bookmarks:null,notInterested:null});assert.deepEqual(native.trend.items,[{date,exposures:0,clicks:2,bookmarks:null,notInterested:null}]);
 series=null;await assert.rejects(panel.recommendationReport({startDate:overview.period.from,endDate:overview.period.to}),{code:'discovery_engine_response_invalid'});
 const partial=await f.operations.topicMetrics(overview.catalog.items,{documents:[],complete:false},overview.period);assert.ok(partial.every(row=>row.supply===null&&row.demand===null&&row.exposures===null&&row.availability.supply==='partial'));
 const payload=(await f.db.query("SELECT payload FROM discovery_usage_events_v1 WHERE payload->'recommendation' IS NOT NULL LIMIT 1")).rows[0].payload;await panel.track(payload);
 const sent=JSON.parse(requests.at(-1).options.body).payload.properties;assert.equal(sent.galaxy_recommendation_request,item.recommendation.requestId);assert.equal(sent.galaxy_policy_version,'none');assert.equal(sent.galaxy_position,1);
 const prior=await f.grant(['recommendations.read']);f.operations.openpanel={recommendationReport:async()=>{await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:prior.assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:prior.assignment.roleId,enabled:false},authorize(f.admin));return {metrics:nullMetrics,trend:{items:[],availability:'not-collected'}};}};
 await assert.rejects(f.operations.overview(f.reader),{code:'operations_permission_denied'});
});

test('new operations routes and proxy accept only exact read/query and CSRF write contracts',async()=>{
 const endpoint='https://official.invalid',admin='https://admin.invalid',base='/v1/operations/recommendation',calls=[];
 const actor={kind:'business-operator',operatorId:'synthetic',endpoint},response={setHeader:()=>{}},service={overview:async(value,input)=>{calls.push({method:'overview',value,input});return {catalog:{items:[]}};},history:async(value,input)=>{calls.push({method:'history',value,input});return {items:[]};},savePolicy:async(value,input,options)=>{assert.equal((await options.authorize()).operatorId,value.operatorId);calls.push({method:'savePolicy',value,input});return {operationId:input.operationId};}};
 let sent;const authorizeOperator=async(request,options)=>{calls.push({auth:options});if(options.write&&request.headers['x-galaxy-operator-csrf']!=='synthetic')throw Object.assign(Error('csrf'),{code:'operations_csrf_invalid'});return actor;};
 const invoke=async(path,{method='GET',csrf='synthetic',input}={})=>{const request=Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]);Object.assign(request,{method,url:path,headers:{'content-type':'application/json',origin:admin,'x-galaxy-operator-csrf':csrf}});return dispatchOperationsRecommendation({operationsRecommendation:service,authorizeOperator,request,response,requestId:'synthetic',url:requestUrl(request,endpoint,[admin]),send:(status,value)=>{sent={status,value};}});};
 const headers=new Headers({origin:admin,'sec-fetch-site':'same-origin'}),valid=base+'/overview?days=30&query='+encodeURIComponent('明确');
 assert.equal(operationsReadPath(valid),true);assert.equal(operationsProxyPolicy({url:admin+valid,method:'GET',headers,publicOrigin:admin}).allowed,true);
 assert.equal(await invoke(valid),true);assert.deepEqual(calls.find(call=>call.method==='overview').input,{days:30,query:'明确'});assert.equal(sent.status,200);
 await invoke(base+'/history?after=5&limit=20');assert.deepEqual(calls.find(call=>call.method==='history').input,{after:'5',limit:20});
 for(const path of [base+'/overview?days=30&days=7',base+'/overview?accountId='+randomUUID(),base+'/history?query=raw',base+'/policy?days=30']){
  assert.equal(operationsReadPath(path),false);assert.equal(operationsProxyPolicy({url:admin+path,method:path.includes('/policy')?'POST':'GET',headers,publicOrigin:admin}).allowed,false);
  await assert.rejects(invoke(path,{method:path.includes('/policy')?'POST':'GET'}));
 }
 const input={operationId:randomUUID()};await invoke(base+'/policy',{method:'POST',input});assert.equal(calls.at(-1).method,'savePolicy');
 await assert.rejects(invoke(base+'/policy',{method:'POST',input,csrf:'wrong'}),{code:'operations_csrf_invalid'});
 await assert.rejects(invoke(base+'/__proto__'),{code:'not_found'});await assert.rejects(invoke(base+'/themes',{method:'PUT'}),{code:'not_found'});
 assert.equal(calls.filter(call=>call.auth?.action==='recommendations.configure').length,2);assert.equal(calls.find(call=>call.auth?.action==='recommendations.read').auth.write,false);
 assert.equal(operationsProxyPolicy({url:admin+base+'/policy',method:'POST',headers:new Headers({origin:'https://foreign.invalid'}),publicOrigin:admin}).allowed,false);
});
