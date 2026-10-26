import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenPanelClient} from '../src/discovery-runtime/native-clients.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {createDiscoveryHttp} from '../src/discovery-runtime/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

const projectId='11111111-1111-4111-8111-111111111111';
const actor={kind:'business-operator',operatorId:'synthetic-operator'};
const nativeOptions={url:'http://openpanel.invalid',projectId,clientId:'w'.repeat(36),clientSecret:'s'.repeat(40),readClientId:'r'.repeat(36),readClientSecret:'t'.repeat(40)};
const counts={reads:28,searches:0,bookmarks:2,participations:3};

test('business counts use native full chart sums, purpose filters and read credentials; absent and malformed counts stay unknown',async()=>{
 const requests=[];
 let response={series:[
  {event:{name:'content-view'},metrics:{sum:28},data:[{count:1}]},
  {event:{name:'search'},metrics:{sum:0}},
  {event:{name:'content-bookmark'},metrics:{sum:2}},
  {event:{name:'content-participate'},metrics:{sum:3}},
 ],metrics:{sum:999999}};
 const panel=new OpenPanelClient({...nativeOptions,fetch:async(url,options)=>{requests.push({url:new URL(url),options});return Response.json(response);}});
 const range={startDate:'2026-10-01T03:24:35.000Z',endDate:'2026-10-08T03:24:34.000Z'};
 assert.deepEqual(await panel.businessCounts(range),counts);
 const {url,options}=requests[0];
 assert.equal(url.pathname,'/export/charts');assert.equal(options.method,'GET');
 assert.equal(options.headers['openpanel-client-id'],nativeOptions.readClientId);
 assert.equal(options.headers['openpanel-client-secret'],nativeOptions.readClientSecret);
 assert.equal(url.searchParams.get('startDate'),range.startDate);assert.equal(url.searchParams.get('endDate'),range.endDate);
 assert.equal(url.searchParams.get('previous'),'false');assert.equal(url.searchParams.get('breakdowns'),'[]');
 const series=JSON.parse(url.searchParams.get('series'));
 assert.deepEqual(series.map(item=>item.name),['content-view','search','content-bookmark','content-participate']);
 for(const item of series){assert.equal(item.segment,'event');assert.deepEqual(item.filters,[{id:'A',name:'properties.purpose',operator:'is',value:['site-usage-analytics']}]);}
 response={series:[{event:{name:'content-view'},metrics:{sum:'28'}},{event:{name:'search'},metrics:{sum:-1}},{event:{name:'content-bookmark'},metrics:{sum:2}},{event:{name:'content-bookmark'},metrics:{sum:3}}]};
 assert.deepEqual(await panel.businessCounts(range),{reads:null,searches:null,bookmarks:null,participations:null});
 response={series:[]};assert.deepEqual(await panel.businessCounts(range),{reads:null,searches:null,bookmarks:null,participations:null});
 response={series:null};await assert.rejects(panel.businessCounts(range),{code:'discovery_engine_response_invalid'});
});

test('business analytics uses two complete disjoint equal second windows and rechecks permission after native reads',async()=>{
 const clock=1792734675,calls=[],checks=[];
 const runtime=new DiscoveryRuntime({endpoint:'https://galaxy.invalid',source:{},store:{},now:()=>clock,
  permissions:{requireAction:async(value,code)=>checks.push({value,code})},
  openpanel:{businessCounts:async range=>{calls.push(range);return calls.length===1?counts:{reads:7,searches:null,bookmarks:0,participations:1};}}});
 const result=await runtime.analytics(actor,{kind:'business',days:3});
 assert.deepEqual(result.data,{unit:'events',current:counts,previous:{reads:7,searches:null,bookmarks:0,participations:1}});
 const iso=offset=>new Date((clock+offset)*1000).toISOString(),window=3*86400;
 assert.deepEqual(calls,[{startDate:iso(-window),endDate:iso(-1)},{startDate:iso(-2*window),endDate:iso(-window-1)}]);
 assert.deepEqual([result.basis.from,result.basis.to,result.basis.previousFrom,result.basis.previousTo],[iso(-window),iso(0),iso(-2*window),iso(-window)]);
 assert.equal(result.basis.windowSeconds,window);assert.equal(result.basis.bounds,'[from,to)');assert.equal(result.basis.precision,'second');
 assert.equal(result.source,'openpanel-native');assert.equal(result.historicalBackfill,false);assert.equal(checks.length,2);
 assert.ok(checks.every(check=>check.value===actor&&check.code==='analytics.read'));
 const before=calls.length;
 for(const input of [{kind:'business',days:0},{kind:'business',days:91},{kind:'business',accountId:projectId},{kind:'business',query:'unbounded'}])await assert.rejects(runtime.analytics(actor,input),{code:'invalid_discovery_request'});
 assert.equal(calls.length,before);
 let available=true;
 const revoked=new DiscoveryRuntime({endpoint:'https://galaxy.invalid',source:{},store:{},now:()=>clock,
  permissions:{requireAction:async()=>{if(!available)throw new ServiceError('operations_forbidden',403);}},
  openpanel:{businessCounts:async()=>{available=false;return counts;}}});
 await assert.rejects(revoked.analytics(actor,{kind:'business'}),{code:'operations_forbidden'});
 const unavailable=new DiscoveryRuntime({endpoint:'https://galaxy.invalid',source:{},store:{},permissions:{requireAction:async()=>{}},openpanel:{businessCounts:async()=>{throw new ServiceError('discovery_engine_unavailable',503);}}});
 await assert.rejects(unavailable.analytics(actor,{kind:'business'}),{code:'discovery_engine_unavailable'});
});

test('single analytics GET accepts business; cohort and path basis preserve the original mixed profile and session scope',async()=>{
 const cohort=[{cohort_interval:'Weighted Average',sum:3,values:[3,2],percentages:[1,2/3]}],nativeCalls=[];
 const runtime=new DiscoveryRuntime({endpoint:'https://galaxy.invalid',source:{},store:{},now:()=>1792734675,permissions:{requireAction:async()=>{}},
  openpanel:{tool:async(name,args)=>{nativeCalls.push({name,args});return name==='get_retention_cohort'?cohort:{nodes:[],links:[]};},businessCounts:async()=>counts}});
 const retention=await runtime.analytics(actor,{kind:'retention'});
 assert.equal(retention.data,cohort);assert.equal(retention.basis.window,'native-last-12-weeks');assert.equal(retention.basis.criteria,'on_or_after');
 assert.equal(retention.basis.population,'mixed-account-and-visitor-profiles');assert.equal(retention.basis.accountOnly,false);assert.equal(retention.basis.accountPrefixFilterSupported,false);
 assert.deepEqual(nativeCalls[0],{name:'get_retention_cohort',args:undefined});
 const paths=await runtime.analytics(actor,{kind:'paths'});assert.equal(paths.basis.unit,'session-path-transitions');assert.equal(paths.basis.scope,'native-top-paths');
 const adapter=createDiscoveryHttp({websiteOrigin:'https://galaxy.invalid',visitorSecret:'v'.repeat(40)}),headers=new Map();let sent,authorized;
 const request={method:'GET',headers:{}},response={setHeader:(key,value)=>headers.set(key,value)};
 const dispatch=url=>adapter.dispatch({discovery:runtime,authorizeOperator:async(value,options)=>{authorized={value,options};return actor;},request,response,url:new URL(url),send:(status,value)=>{sent={status,value};}});
 assert.equal(await dispatch('https://official.invalid/v1/operations/discovery/analytics?kind=business&days=2'),true);
 assert.equal(sent.status,200);assert.equal(sent.value.kind,'business');assert.equal(sent.value.basis.windowSeconds,2*86400);
 assert.equal(authorized.value,request);assert.equal(authorized.options.action,'analytics.read');assert.equal(authorized.options.write,false);assert.equal(headers.get('Cache-Control'),'no-store');
 await assert.rejects(dispatch('https://official.invalid/v1/operations/discovery/analytics?kind=business&days=2&profileId=outside'),{code:'invalid_discovery_request'});
});
