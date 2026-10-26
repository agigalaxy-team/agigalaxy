import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {OpenPanelClient} from '../src/discovery-runtime/native-clients.mjs';
import {OperationsAccountUsageSummary} from '../src/operations/accounts/usage-summary.mjs';
import {queryProjection} from "../src/operations/agentos/query-view.mjs";
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';

// Real PG/API role, grants, account lookup, DiscoveryRuntime and OpenPanel
// client. Only the management directory and native HTTP transport are local
// doubles. No provider, production event collection or model analysis runs.
test('account usage summary bridges native facts with exact ownership, distinct periods and current permission without exposing detailed paths',{timeout:60000},async t=>{
 const raw=new PGlite();t.after(()=>raw.close());await migrate(raw,{roles:['api']});
 let transactionDepth=0;const clock=Date.parse('2026-10-24T01:00:00.000Z')/1000;
 const db={query:raw.query.bind(raw),transaction:operation=>raw.transaction(async connection=>{transactionDepth++;try{return await operation(connection);}finally{transactionDepth--;}})},
  endpoint='https://usage-summary.example.invalid',foreign='https://foreign-usage.example.invalid',accountId=randomUUID(),otherId=randomUUID(),now=()=>clock,at=new Date(clock*1000).toISOString(),
  admin={kind:'business-operator',operatorId:'account-usage-admin',role:'administrator',endpoint},reader={...admin,operatorId:'account-usage-reader',role:'reader'},ungranted={...reader,operatorId:'account-usage-ungranted'};
 for(const [id,scope,uid]of [[accountId,endpoint,'G00000000001'],[otherId,foreign,'G00000000002']])await raw.query("INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,$3,'https://accounts.example.invalid',$1::text,'email',$4,$4)",[id,uid,scope,at]);
 for(const actor of [admin,reader,ungranted])await raw.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.example.invalid',$1,'测试账户分析者',$3,$3)",[actor.operatorId,endpoint,at]);
 const businessAdmin=new BusinessAdminService({db,endpoint,now}),authority=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['analytics.read']});authority.roles.set(ungranted.operatorId,'reader');
 await raw.exec('SET ROLE galaxy_api');
 const calls=[],secret='PRIVATE_QUERY_AND_OBJECT_REFERENCE',nodeId='/app/community/posts/'+randomUUID()+'?query='+secret;
 let mode='normal',afterNative=null;
 const client=new OpenPanelClient({url:'https://native.example.invalid',projectId:randomUUID(),clientId:'w'.repeat(36),clientSecret:'s'.repeat(40),readClientId:'r'.repeat(36),readClientSecret:'t'.repeat(40),fetch:async(url,options)=>{
  const request=new URL(url);calls.push(request);assert.equal(options.method,'GET');assert.equal(transactionDepth,0,'native I/O never holds the BusinessAdmin transaction');
  assert.equal((await raw.query('SELECT current_user AS role')).rows[0].role,'galaxy_api','real API role can finish independent native authorization reads');
  let body,headers={};
  if(request.pathname.endsWith('/metrics')){
   assert.equal(decodeURIComponent(request.pathname.split('/').at(-2)),'account:'+accountId);assert.equal(request.searchParams.has('days'),false);
   if(mode==='partial')return Response.json({message:secret},{status:503});
   body=mode==='missing'?{profileId:'account:'+accountId}:mode==='mismatch'?{profileId:'account:'+otherId,sessions:999}:{profileId:'account:'+accountId,firstSeen:'2026-09-01T00:00:00.000Z',lastSeen:at,sessions:3,screenViews:0,totalEvents:21,conversionEvents:5,uniqueDaysActive:9,avgSessionDurationMin:1.5,p90SessionDurationMin:2.1,avgEventsPerSession:7,avgTimeBetweenSessionsSec:120,bounceRate:0,revenue:999,email:secret,body:secret,properties:{query:secret}};
  }else{
   assert.equal(request.searchParams.get('scope'),'accounts');assert.equal(request.searchParams.get('accountId'),accountId);
   headers={'X-Galaxy-Analytics-Scope':'accounts','X-Galaxy-Analytics-Account-Id':accountId,...(mode==='unknown-zone'?{}:{'X-Galaxy-Analytics-Timezone':'Asia/Shanghai'})};
   if(request.pathname.endsWith('/user_flow')){
    assert.equal(request.searchParams.get('steps'),'5');assert.equal(request.searchParams.get('startEvent'),'screen_view');
    body=mode==='empty'?{nodes:[],links:[]}:{nodes:[{id:nodeId,label:mode==='unsafe-path'?'/app/community/'+secret:'screen_view',step:1,value:4,percentage:100,url:secret},{id:'search?'+secret,label:'search',step:2,value:2,percentage:50,query:secret}],links:[{source:nodeId,target:'search?'+secret,value:2,body:secret}],totalSessions:900};
   }else{
    assert(request.pathname.endsWith('/retention/cohort'));assert.equal(request.searchParams.has('days'),false);assert.equal(request.searchParams.has('startDate'),false);
    body=mode==='empty'?[]:[{cohort_interval:'2026-10-05',sum:1,values:[1,0,0],percentages:[1,0,0],account:secret},{cohort_interval:'2026-10-19',sum:1,values:[1,0,0],percentages:[1,0,0]}];
   }
  }
  await afterNative?.();return Response.json(body,{headers});
 }});
 const discovery=new DiscoveryRuntime({db,endpoint,source:{},store:{},now,openpanel:client,permissions:authority.permissions}),service=new OperationsAccountUsageSummary({businessAdmin,discovery,now});businessAdmin.accountUsageAnalysis=service;
 const summary=await businessAdmin.accountSummary(reader,accountId,{days:28}),result=summary.usageAnalysis;
 assert.equal(summary.accountId,accountId);assert.equal(summary.days,28);assert.equal(summary.period.timeZone,'Asia/Shanghai');assert.equal(summary.readExpiresAt,result.readExpiresAt);
 for(const field of ['activeDays','searches','bookmarks','participation'])assert.equal(summary.usage[field],null,'lifetime native metrics do not fill a recent-day fact');
 assert.equal(summary.profile.state,'not-analyzed');assert.equal(summary.predictions.participation.state,'not-analyzed');assert.equal(summary.predictions.needs.state,'not-analyzed');assert.equal(summary.recommendations.state,'not-analyzed');
 assert.equal(result.accountId,accountId);assert.equal(result.readExpiresAt,clock+30);assert.equal(result.source,'openpanel-native');assert.equal(result.purpose,'site-usage-analytics');assert.equal(result.historicalBackfill,false);
 assert.equal(result.lifetime.availability.state,'available');assert.equal(result.lifetime.basis.window,'native-lifetime');assert.equal(result.lifetime.data.uniqueDaysActive,9);assert.equal(result.lifetime.data.screenViews,0);assert.equal(result.lifetime.data.bounceRate,0);assert.equal(result.lifetime.data.avgSessionDurationMin,1.5);
 assert.equal(result.paths.basis.scope,'native-top-paths');assert.equal(result.paths.basis.classification,'event-family');assert.equal(Date.parse(result.paths.basis.to)-Date.parse(result.paths.basis.from),28*86400000);
 assert.deepEqual(result.paths.data,{nodes:[{id:'n0',label:'screen_view',step:1,value:4,percentage:100},{id:'n1',label:'search',step:2,value:2,percentage:50}],links:[{source:'n0',target:'n1',value:2}]});
 assert.equal(result.retention.basis.window,'native-last-12-weeks');assert.equal(result.retention.basis.cohortEntry,'first-qualified-activity-in-window');assert.equal(result.retention.basis.population,'single-account-profile');
 assert.equal(result.retention.data.rows[0].cells[1].state,'recorded');assert.equal(result.retention.data.rows[0].cells[1].ratio,0,'a mature native zero stays zero');assert.equal(result.retention.data.rows[1].cells[1].state,'not-reached');assert.equal(result.retention.data.rows[1].cells[1].ratio,null,'native zero-fill for a future week is not a return rate');
 for(const privateValue of [secret,nodeId,'revenue','email','properties','profileId','interests','predictions'])assert(!JSON.stringify(result).includes(privateValue));
 const projected=queryProjection.accountSummary({...summary,usageAnalysis:{...result,rawProvider:{url:secret},lifetime:{...result.lifetime,data:{...result.lifetime.data,email:secret,revenue:999}},paths:{...result.paths,data:{...result.paths.data,nodes:result.paths.data.nodes.map(node=>({...node,url:secret,query:secret}))}}}});
 assert.equal(projected.usageAnalysis.lifetime.data.uniqueDaysActive,9);assert.equal(projected.usageAnalysis.lifetime.data.screenViews,0);assert.deepEqual(projected.usageAnalysis.paths.data,result.paths.data);assert.deepEqual(projected.usageAnalysis.retention.data,result.retention.data);assert.equal(projected.profile.state,'not-analyzed');assert(!JSON.stringify(projected).includes(secret));assert(!JSON.stringify(projected).includes('revenue'));
 const wrongPath=queryProjection.accountSummary({...summary,usageAnalysis:{...result,paths:{...result.paths,data:{nodes:[{id:nodeId,label:secret,step:1,value:99}],links:[]}}}});
 assert.equal(wrongPath.usageAnalysis.paths.availability.state,'unavailable');assert.equal(wrongPath.usageAnalysis.paths.data,null);assert(!JSON.stringify(wrongPath).includes(secret));
 assert.equal(calls.length,3);
 mode='missing';const missing=await service.get(reader,accountId.toUpperCase());assert.equal(missing.lifetime.data.sessions,null);assert.equal(missing.lifetime.data.uniqueDaysActive,null);assert.equal(missing.lifetime.data.firstSeen,null);
 mode='mismatch';assert.equal((await service.get(reader,accountId)).lifetime.availability.state,'unavailable');
 mode='partial';const partial=await service.get(reader,accountId);assert.deepEqual(partial.lifetime.availability,{state:'unavailable',code:'discovery_engine_failed'});assert.equal(partial.lifetime.data,null);assert.equal(partial.paths.availability.state,'available');assert.equal(partial.retention.availability.state,'available');
 mode='unsafe-path';const unsafe=await service.get(reader,accountId);assert.equal(unsafe.paths.availability.state,'unavailable');assert.equal(unsafe.paths.data,null);assert(!JSON.stringify(unsafe).includes(secret));
 mode='empty';const empty=await service.get(reader,accountId);assert.deepEqual(empty.paths.data,{nodes:[],links:[]});assert.deepEqual(empty.retention.data,{rows:[],weeks:[]});
 mode='unknown-zone';const unknown=await service.get(reader,accountId);assert.equal(unknown.retention.basis.timezone.name,null);
 const disconnected=await new OperationsAccountUsageSummary({businessAdmin,now}).get(reader,accountId);for(const key of ['lifetime','paths','retention']){assert.equal(disconnected[key].availability.state,'not-connected');assert.equal(disconnected[key].data,null);assert.equal(disconnected[key].basis,null);}
 const count=calls.length;
 for(const [actor,id,input,code]of [[ungranted,accountId,{},'operations_permission_denied'],[{...ungranted,role:'administrator'},accountId,{},'operations_permission_denied'],[{...reader,endpoint:foreign},accountId,{},'business_admin_denied'],[reader,otherId,{},'not_found'],[reader,randomUUID(),{},'not_found'],[reader,accountId,{days:30},'invalid_business_admin_request'],[reader,accountId,{query:secret},'invalid_business_admin_request']])await assert.rejects(service.get(actor,id,input),{code});
 assert.equal(calls.length,count,'invalid scope or current authorization never reaches native analytics');
 // Revoke the actual stored reader assignment while native I/O is pending.
 // The runtime's original after-read check must reject the entire result.
 const assignment=(await authority.permissions.personnel(admin)).items.find(item=>item.operatorId===reader.operatorId).assignments[0];
 mode='normal';afterNative=async()=>{afterNative=null;await authority.permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:assignment.roleId,enabled:false},{authorize:async()=>admin});};
 await assert.rejects(service.get(reader,accountId),{code:'operations_permission_denied'});assert.equal(calls.length,count+1);
 assert.equal((await raw.query('SELECT count(*)::int AS count FROM discovery_usage_events_v1')).rows[0].count,0,'analysis does not create usage events or inferred profiles');
});
