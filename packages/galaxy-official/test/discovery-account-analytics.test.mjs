import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenPanelClient} from '../src/discovery-runtime/native-clients.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {createDiscoveryHttp} from '../src/discovery-runtime/http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

const projectId='11111111-1111-4111-8111-111111111111';
const accountId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherAccount='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor={kind:'business-operator',operatorId:'synthetic-operator'};
const nativeOptions={url:'http://openpanel.invalid',projectId,clientId:'w'.repeat(36),clientSecret:'s'.repeat(40),readClientId:'r'.repeat(36),readClientSecret:'t'.repeat(40)};
const sourceUrl='https://agigalaxy.org/open-source/openpanel-public2-galaxy-path-memory-20261025-r1/source.tar.gz';
const pathData={nodes:[],links:[]};

test('account native reads require exact scope/account acknowledgement and preserve empty data and truthful timezone',async()=>{
 const requests=[];let next={body:[],headers:{'X-Galaxy-Analytics-Scope':'accounts'}};
 const native=new OpenPanelClient({...nativeOptions,fetch:async(url,options)=>{requests.push({url:new URL(url),options});return Response.json(next.body,{headers:next.headers});}});
 const cohort=await native.accountAnalysis('get_retention_cohort');
 assert.deepEqual(cohort,{data:[],timezone:null});
 assert.equal(requests[0].url.pathname,'/insights/'+projectId+'/retention/cohort');
 assert.equal(requests[0].url.searchParams.get('scope'),'accounts');assert.equal(requests[0].url.searchParams.has('accountId'),false);
 assert.equal(requests[0].options.method,'GET');assert.equal(requests[0].options.headers['openpanel-client-id'],nativeOptions.readClientId);
 next={body:pathData,headers:{'X-Galaxy-Analytics-Scope':'accounts','X-Galaxy-Analytics-Account-Id':accountId,'X-Galaxy-Analytics-Timezone':'Asia/Shanghai'}};
 const paths=await native.accountAnalysis('get_user_flow',{accountId,startDate:'2026-10-01T01:00:00.000Z',endDate:'2026-10-08T01:00:00.000Z',startEvent:'screen_view',mode:'after',steps:5});
 assert.deepEqual(paths,{data:pathData,timezone:'Asia/Shanghai'});
 assert.equal(requests[1].url.pathname,'/insights/'+projectId+'/user_flow');assert.equal(requests[1].url.searchParams.get('accountId'),accountId);
 for(const headers of [{},{'X-Galaxy-Analytics-Scope':'all'},{'X-Galaxy-Analytics-Scope':'accounts','X-Galaxy-Analytics-Account-Id':otherAccount}]){
  next={body:pathData,headers};await assert.rejects(native.accountAnalysis('get_user_flow',{accountId}),{code:'discovery_analysis_scope_unavailable'});
 }
 next={body:[],headers:{'X-Galaxy-Analytics-Scope':'accounts','X-Galaxy-Analytics-Account-Id':accountId}};
 await assert.rejects(native.accountAnalysis('get_retention_cohort'),{code:'discovery_analysis_scope_unavailable'});
 next={body:[],headers:{'X-Galaxy-Analytics-Scope':'accounts','X-Galaxy-Analytics-Timezone':'not-a-timezone'}};
 await assert.rejects(native.accountAnalysis('get_retention_cohort'),{code:'discovery_engine_response_invalid'});
 next={body:{},headers:{'X-Galaxy-Analytics-Scope':'accounts'}};
 await assert.rejects(native.accountAnalysis('get_user_flow'),{code:'discovery_engine_response_invalid'});
 await assert.rejects(native.accountAnalysis('get_profile_metrics',{accountId}),{code:'discovery_analysis_not_supported'});
 // The unscoped legacy native route retains its original body and needs no new header.
 next={body:[],headers:{}};assert.deepEqual(await native.tool('get_retention_cohort'),[]);
 assert.equal(requests.at(-1).url.searchParams.has('scope'),false);
});

test('account analytics isolates legal kind combinations, normalized target and fresh authorization without identifying visitor history',async()=>{
 const calls=[],checks=[];
 const panel={accountAnalysis:async(name,args)=>{calls.push({name,args});return {data:name==='get_retention_cohort'?[]:pathData,timezone:name==='get_user_flow'?'Asia/Shanghai':null};},tool:async(name,args)=>{calls.push({name,args});return name==='get_retention_cohort'?[]:name==='get_user_flow'?pathData:{profile:true};}};
 const runtime=new DiscoveryRuntime({endpoint:'https://official.invalid',source:{},store:{},now:()=>1792734675,openpanel:panel,permissions:{requireAction:async(value,code)=>checks.push({value,code})}});
 const all=await runtime.analytics(actor,{kind:'retention',scope:'accounts',days:2});
 assert.deepEqual(all.data,[]);assert.equal(all.basis.identityScope,'accounts');assert.equal(all.basis.population,'account-profiles');assert.equal(all.basis.accountOnly,true);assert.equal(all.basis.accountPrefixFilterSupported,true);
 assert.equal(all.basis.window,'native-last-12-weeks');assert.equal(all.basis.cohortEntry,'first-qualified-activity-in-window');assert.equal(all.basis.criteria,'on_or_after');
 assert.deepEqual(all.basis.timezone,{source:'native-clickhouse-default',name:null});assert.equal(all.basis.componentSourceUrl,sourceUrl);assert.equal('accountId' in all.basis,false);
 assert.deepEqual(calls[0],{name:'get_retention_cohort',args:{}});
 const single=await runtime.analytics(actor,{kind:'retention',scope:'accounts',accountId:accountId.toUpperCase()});
 assert.equal(single.basis.population,'single-account-profile');assert.equal(single.basis.accountId,accountId);assert.deepEqual(calls[1].args,{accountId});
 const flow=await runtime.analytics(actor,{kind:'paths',scope:'accounts',accountId,days:2});
 assert.deepEqual(flow.data,pathData);assert.equal(flow.basis.unit,'account-session-path-transitions');assert.equal(flow.basis.scope,'native-top-paths');assert.equal(flow.basis.identityScope,'accounts');
 assert.equal(flow.basis.population,'single-account-profile');assert.deepEqual(flow.basis.timezone,{source:'native-project-settings',name:'Asia/Shanghai'});
 assert.equal(calls[2].args.accountId,accountId);assert.equal(calls[2].args.startEvent,'screen_view');
 assert.equal(new Date(flow.basis.to)-new Date(flow.basis.from),2*86400000);
 const legacy=await runtime.analytics(actor,{kind:'retention'});assert.equal(legacy.basis.population,'mixed-account-and-visitor-profiles');assert.equal(legacy.basis.accountOnly,false);assert.equal('identityScope' in legacy.basis,false);assert.equal('componentSourceUrl' in legacy.basis,false);
 await runtime.analytics(actor,{kind:'account',accountId});assert.deepEqual(calls.at(-1),{name:'get_profile_metrics',args:{profileId:'account:'+accountId}});
 const before=calls.length;
 for(const input of [{kind:'retention',accountId},{kind:'paths',accountId},{kind:'overview',scope:'accounts'},{kind:'business',scope:'accounts'},{kind:'account',scope:'accounts',accountId},{kind:'account'},{kind:'retention',scope:'visitors'},{kind:'paths',scope:'accounts',accountId:'visitor:'+accountId},{kind:'paths',scope:'accounts',filters:[]},{kind:'paths',scope:'accounts',days:91}])await assert.rejects(runtime.analytics(actor,input),{code:'invalid_discovery_request'});
 assert.equal(calls.length,before);assert.equal(checks.filter(item=>item.value!==actor||item.code!=='analytics.read').length,0);
 let authorized=true,read=0;
 const revoked=new DiscoveryRuntime({endpoint:'https://official.invalid',source:{},store:{},permissions:{requireAction:async()=>{if(!authorized)throw new ServiceError('operations_forbidden',403);}},openpanel:{accountAnalysis:async()=>{read++;authorized=false;return {data:[],timezone:null};}}});
 await assert.rejects(revoked.analytics(actor,{kind:'retention',scope:'accounts',accountId}),{code:'operations_forbidden'});assert.equal(read,1);
 await assert.rejects(revoked.analytics(actor,{kind:'retention',scope:'accounts',accountId}),{code:'operations_forbidden'});assert.equal(read,1);
});

test('scope query survives the exact central and admin proxy route while duplicate/unknown parameters and write methods fail closed',async()=>{
 const endpoint='https://official.invalid',admin='https://admin.invalid',base='/v1/operations/discovery/analytics';
 const adapter=createDiscoveryHttp({websiteOrigin:'https://galaxy.invalid',visitorSecret:'v'.repeat(40)}),seen=[];let sent;
 const runtime=new DiscoveryRuntime({endpoint,source:{},store:{},permissions:{requireAction:async()=>{}},openpanel:{accountAnalysis:async(name,args)=>{seen.push({name,args});return {data:[],timezone:null};}}});
 const invoke=async query=>{
  const request={method:'GET',url:base+query,headers:{}},response={setHeader:()=>{}};
  const url=requestUrl(request,endpoint);
  return adapter.dispatch({discovery:runtime,request,response,url,requestId:'synthetic',authorizeOperator:async(_request,options)=>{assert.equal(options.action,'analytics.read');return actor;},send:(status,value)=>{sent={status,value};}});
 };
 const query='?kind=retention&scope=accounts&accountId='+accountId+'&days=7';
 assert.equal(operationsReadPath(base+query),true);
 const headers=new Headers({origin:admin,'sec-fetch-site':'same-origin'});
 assert.equal(operationsProxyPolicy({url:admin+base+query,method:'GET',headers,publicOrigin:admin}).allowed,true);
 assert.equal(await invoke(query),true);assert.equal(sent.status,200);assert.equal(sent.value.basis.accountId,accountId);assert.deepEqual(seen,[{name:'get_retention_cohort',args:{accountId}}]);
 for(const invalid of ['?kind=retention&scope=accounts&scope=accounts','?kind=paths&scope=accounts&accountId='+accountId+'&accountId='+otherAccount,'?kind=retention&scope=accounts&projectId='+projectId,'?kind=paths&scope=accounts&filters=%5B%5D']){
  assert.equal(operationsReadPath(base+invalid),false);
  assert.equal(operationsProxyPolicy({url:admin+base+invalid,method:'GET',headers,publicOrigin:admin}).allowed,false);
  assert.throws(()=>requestUrl({method:'GET',url:base+invalid,headers:{}},endpoint),{code:'invalid_request'});
  await assert.rejects(adapter.dispatch({discovery:runtime,request:{method:'GET',headers:{}},response:{setHeader:()=>{}},url:new URL(endpoint+base+invalid),authorizeOperator:async()=>actor,send:()=>{throw Error('invalid request must not send');}}),{code:'invalid_discovery_request'});
 }
 assert.equal(operationsProxyPolicy({url:admin+base+query,method:'POST',headers,publicOrigin:admin}).allowed,false);
 await assert.rejects(invoke('?kind=retention&accountId='+accountId),{code:'invalid_discovery_request'});
 assert.equal(seen.length,1);
});
