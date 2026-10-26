import {z} from 'zod';
import {ServiceError} from '../shared/service-error.mjs';
import {discoveryParse} from './purpose.mjs';
import {discoveryBusinessEvents} from './native-clients.mjs';

// Original analytics contract and authorization remain here; search,
// recommendation, indexing and delivery do not own analytics windows.
const analyticsSchema=z.strictObject({kind:z.enum(['overview','retention','paths','account','business']),days:z.number().int().min(1).max(90).default(7),scope:z.literal('accounts').optional(),accountId:z.uuid().transform(value=>value.toLowerCase()).optional()});
const accountAnalysisComponentSource='https://agigalaxy.org/open-source/openpanel-public2-galaxy-path-memory-20261025-r1/source.tar.gz';
function accountAnalysisBasis(request,native,timezoneSource){return {identityScope:'accounts',population:request.accountId?'single-account-profile':'account-profiles',accountOnly:true,...(request.accountId?{accountId:request.accountId}:{}),timezone:{source:timezoneSource,name:native.timezone??null},componentSourceUrl:accountAnalysisComponentSource};}

function overviewNativeTimezone(data){
 const name=typeof data?.timezone==='string'&&data.timezone.length<=100?data.timezone:null;
 if(name)try{new Intl.DateTimeFormat('en',{timeZone:name}).format(0);return {source:'native-project-settings',name};}catch{}
 return {source:'not-reported',name:null};
}

export async function readUsageAnalytics(runtime,actor,input){if(!runtime.permissions)throw new ServiceError('operations_authorization_unavailable',503);await runtime.permissions.requireAction(actor,'analytics.read');if(!runtime.openpanel)throw new ServiceError('discovery_analysis_not_connected',503);const request=discoveryParse(analyticsSchema,input),scopeKind=request.kind==='retention'||request.kind==='paths';if(request.scope&&!scopeKind||request.accountId&&request.kind!=='account'&&!(scopeKind&&request.scope==='accounts')||request.kind==='account'&&!request.accountId)throw new ServiceError('invalid_discovery_request',400);const observedAt=runtime.now(),windowSeconds=request.days*86400,startDate=new Date((observedAt-windowSeconds)*1000).toISOString(),endDate=new Date(observedAt*1000).toISOString();let data,basis;
  if(request.kind==='business'){
   const previousFrom=new Date((observedAt-2*windowSeconds)*1000).toISOString(),previousTo=startDate;
   // Galaxy's accepted usage timestamps have whole-second precision. Native
   // chart bounds are inclusive, so subtract one second from each exclusive
   // end to keep the two equal-size second windows disjoint.
   const [current,previous]=await Promise.all([
    runtime.openpanel.businessCounts({startDate,endDate:new Date((observedAt-1)*1000).toISOString()}),
    runtime.openpanel.businessCounts({startDate:previousFrom,endDate:new Date((observedAt-windowSeconds-1)*1000).toISOString()}),
   ]);
   data={unit:'events',current,previous};basis={from:startDate,to:endDate,previousFrom,previousTo,windowSeconds,bounds:'[from,to)',precision:'second',aggregation:'native-chart-metrics-sum',eventNames:discoveryBusinessEvents};
  }
  else if(request.kind==='retention'){
   if(request.scope==='accounts'){const native=await runtime.openpanel.accountAnalysis('get_retention_cohort',(request.accountId?{accountId:request.accountId}:{}));data=native.data;basis={window:'native-last-12-weeks',interval:'week',criteria:'on_or_after',activity:'any-event',...accountAnalysisBasis(request,native,'native-clickhouse-default'),identityRule:request.accountId?'profile_id = account:<UUID>':'profile_id starts with account:',accountPrefixFilterSupported:true,cohortEntry:'first-qualified-activity-in-window'};}
   else{data=await runtime.openpanel.tool('get_retention_cohort');basis={window:'native-last-12-weeks',interval:'week',criteria:'on_or_after',activity:'any-event',population:'mixed-account-and-visitor-profiles',identityRule:'profile_id != device_id',accountOnly:false,accountPrefixFilterSupported:false};}
  }
  else if(request.kind==='paths'){
   const args={startDate,endDate,startEvent:'screen_view',mode:'after',steps:5,include:['screen_view','content-view','content-click','search','search-click','content-bookmark','content-participate']};
   if(request.scope==='accounts'){const native=await runtime.openpanel.accountAnalysis('get_user_flow',{...args,...(request.accountId?{accountId:request.accountId}:{})});data=native.data;basis={from:startDate,to:endDate,unit:'account-session-path-transitions',scope:'native-top-paths',...accountAnalysisBasis(request,native,'native-project-settings')};}
   else{data=await runtime.openpanel.tool('get_user_flow',args);basis={from:startDate,to:endDate,unit:'session-path-transitions',scope:'native-top-paths'};}
  }
  else if(request.kind==='account'){data=await runtime.openpanel.tool('get_profile_metrics',{profileId:'account:'+request.accountId});basis={window:'native-lifetime',accountId:request.accountId};}
  else{data=await runtime.openpanel.tool('get_analytics_overview',{startDate,endDate,interval:'day'});basis={from:startDate,to:endDate,interval:'day',timezone:overviewNativeTimezone(data)};}
  await runtime.permissions.requireAction(actor,'analytics.read');return {kind:request.kind,data,basis,source:'openpanel-native',purpose:'site-usage-analytics',coverage:['home','community','find','account','help','download'],checkedAt:runtime.now(),historicalBackfill:false};
 }
