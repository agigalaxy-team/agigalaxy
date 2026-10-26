import type {AnalyticsAudienceBasis,AnalyticsBusinessCounts,AnalyticsBusinessData,AnalyticsFlowData,AnalyticsFlowNode,AnalyticsKind,AnalyticsLocation,AnalyticsOverviewData,AnalyticsRetentionData,AnalyticsSeriesPoint} from "../../components/analytics/analytics-types";
import {normalizeAnalyticsRetention} from "../../../../../packages/galaxy-official/src/shared/analytics-retention.mjs";

const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function analyticsValue(value:unknown){return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;}
export function analyticsNumber(value:unknown){const number=analyticsValue(value);return number===null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(number);}
export function analyticsPercent(value:unknown,scale:'percent'|'ratio'='percent'){const number=analyticsValue(value),maximum=scale==='ratio'?1:100;return number===null||number>maximum?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(number*(scale==='ratio'?100:1))+'%';}
export function analyticsDurationSeconds(value:unknown){const number=analyticsValue(value);if(number===null)return '—';if(number<60)return analyticsNumber(number)+' 秒';const seconds=Math.round(number);return Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const analyticsSearchKeys=['days','scope','accountId'] as const;
export function analyticsLocation(input:Record<string,string>):AnalyticsLocation{
 const location:AnalyticsLocation={days:/^[1-9][0-9]?$/.test(input.days??'')&&Number(input.days)<=90?Number(input.days):7};
 if(input.scope==='accounts'){location.scope='accounts';if(uuid.test(input.accountId??''))location.accountId=input.accountId.toLowerCase();}
 return location;
}
export function analyticsHref(location:AnalyticsLocation,patch:Partial<AnalyticsLocation>={}){
 const candidate={...location,...patch},next=analyticsLocation({days:String(candidate.days),scope:candidate.scope??'',accountId:candidate.accountId??''}),query=new URLSearchParams();
 if(next.days!==7)query.set('days',String(next.days));
 if(next.scope){query.set('scope',next.scope);if(next.accountId)query.set('accountId',next.accountId);}
 return '/admin/operations/analytics'+(query.size?'?'+query:'');
}
export function analyticsPath(kind:AnalyticsKind,days=7,accountId='',scope?:'accounts'){
 if(!['overview','retention','paths','account','business'].includes(kind)||!Number.isInteger(days)||days<1||days>90||scope!==undefined&&(scope!=='accounts'||!['retention','paths'].includes(kind))||kind==='account'&&!uuid.test(accountId)||scope==='accounts'&&accountId!==''&&!uuid.test(accountId))return null;
 const query=new URLSearchParams({kind,days:String(days)});
 if(kind==='account')query.set('accountId',accountId);
 if(scope==='accounts'){query.set('scope',scope);if(accountId)query.set('accountId',accountId.toLowerCase());}
 return '/v1/operations/discovery/analytics?'+query;
}
const accountComponentSource='https://agigalaxy.org/open-source/openpanel-public2-galaxy-accounts-20261023/source.tar.gz';
function analyticsTimeZone(value:unknown){
 const zone=record(value);if(!zone||!['native-project-settings','native-clickhouse-default'].includes(String(zone.source))||typeof zone.name!=='string'||zone.name.length>80)return null;
 try{return new Intl.DateTimeFormat('en',{timeZone:zone.name}).resolvedOptions().timeZone;}catch{return null;}
}
export function analyticsAudienceBasis(value:unknown,kind:'retention'|'paths',location:AnalyticsLocation):AnalyticsAudienceBasis|null{
 const basis=record(value);if(!basis)return null;
 if(kind==='retention'&&(basis.window!=='native-last-12-weeks'||basis.interval!=='week'||basis.criteria!=='on_or_after'||basis.activity!=='any-event'))return null;
 if(kind==='paths'&&basis.scope!=='native-top-paths')return null;
 if(location.scope==='accounts'){
  if(basis.identityScope!=='accounts'||basis.accountOnly!==true||basis.population!==(location.accountId?'single-account-profile':'account-profiles'))return null;
  if(location.accountId?basis.accountId!==location.accountId: basis.accountId!==undefined)return null;
  if(kind==='retention'&&(basis.accountPrefixFilterSupported!==true||basis.cohortEntry!=='first-qualified-activity-in-window'))return null;
  if(kind==='paths'&&basis.unit!=='account-session-path-transitions')return null;
  return {object:location.accountId?'account':'accounts',timeZone:analyticsTimeZone(basis.timezone),componentSourceUrl:basis.componentSourceUrl===accountComponentSource?accountComponentSource:null};
 }
 if(basis.accountOnly===true||basis.identityScope==='accounts'||basis.accountId!==undefined)return null;
 if(kind==='retention'&&(basis.accountOnly!==false||basis.population!=='mixed-account-and-visitor-profiles'))return null;
 if(kind==='paths'&&basis.unit!=='session-path-transitions')return null;
 return {object:'all',timeZone:analyticsTimeZone(basis.timezone),componentSourceUrl:null};
}
export function analyticsDate(value:unknown,full=false){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value))return '未记录';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '未记录';return new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',...(full?{year:'numeric' as const}:{}),month:'2-digit',day:'2-digit'}).format(date);}
export function analyticsOverview(value:unknown):AnalyticsOverviewData|null{
 const source=record(value),summary=record(source?.summary);if(!source||!summary||!Array.isArray(source.series))return null;
 const sessions=analyticsValue(summary.total_sessions),sessionValue=(value:unknown)=>sessions===0?null:analyticsValue(value);
 const series:AnalyticsSeriesPoint[]=source.series.flatMap(item=>{const row=record(item);if(!row||typeof row.date!=='string'||analyticsDate(row.date)==='未记录')return [];return [{date:row.date,unique_visitors:analyticsValue(row.unique_visitors),total_screen_views:analyticsValue(row.total_screen_views),total_sessions:analyticsValue(row.total_sessions)}];}).sort((a,b)=>a.date.localeCompare(b.date));
 return {summary:{unique_visitors:analyticsValue(summary.unique_visitors),total_screen_views:analyticsValue(summary.total_screen_views),total_sessions:sessions,bounce_rate:sessionValue(summary.bounce_rate)!==null&&Number(summary.bounce_rate)<=100?Number(summary.bounce_rate):null,avg_session_duration:sessionValue(summary.avg_session_duration),views_per_session:sessionValue(summary.views_per_session)},series,...(source.interval==='day'?{interval:'day' as const}:{}),...(typeof source.startDate==='string'?{startDate:source.startDate}:{}),...(typeof source.endDate==='string'?{endDate:source.endDate}:{})};
}
export function analyticsRetention(value:unknown,checkedAt:number,timeZone?:string|null):AnalyticsRetentionData|null{
 return normalizeAnalyticsRetention(value,checkedAt,timeZone);
}
export const analyticsEventLabels:Record<string,string>={'screen_view':'页面访问','content-view':'阅读公开内容','content-click':'点击公开内容','search':'搜索','search-click':'点击搜索结果','content-bookmark':'收藏公开内容','content-participate':'发表或回复'};
export function analyticsFlow(value:unknown):AnalyticsFlowData|null{
 const source=record(value);if(!source||!Array.isArray(source.nodes)||!Array.isArray(source.links))return null;
 const nodes:AnalyticsFlowNode[]=[],seen=new Set<string>();
 for(const item of source.nodes){const row=record(item);if(!row||typeof row.id!=='string'||seen.has(row.id)||typeof row.label!=='string'||!Object.hasOwn(analyticsEventLabels,row.label)||typeof row.step!=='number'||!Number.isInteger(row.step)||row.step<1||row.step>10)continue;seen.add(row.id);const percentage=analyticsValue(row.percentage);nodes.push({id:row.id,label:analyticsEventLabels[row.label],step:row.step,value:analyticsValue(row.value),percentage:percentage!==null&&percentage<=100?percentage:null});}
 const byId=new Map(nodes.map(row=>[row.id,row]));
 const links=source.links.flatMap(item=>{const row=record(item);if(!row||typeof row.source!=='string'||typeof row.target!=='string'||!byId.has(row.source)||!byId.has(row.target)||byId.get(row.target)!.step<=byId.get(row.source)!.step)return [];return [{source:row.source,target:row.target,value:analyticsValue(row.value)}];});
 if(source.nodes.length&&!nodes.length||source.links.length&&!links.length)return null;
 return {nodes:nodes.sort((a,b)=>a.step-b.step||(b.value??-1)-(a.value??-1)),links};
}
export const analyticsBusinessLabels={reads:'阅读公开内容',searches:'搜索',bookmarks:'收藏公开内容',participations:'发表与回复'} as const;
export function analyticsBusiness(value:unknown):AnalyticsBusinessData|null{
 const source=record(value),current=record(source?.current),previous=record(source?.previous);if(source?.unit!=='events'||!current||!previous)return null;
 const counts=(row:Record<string,unknown>):AnalyticsBusinessCounts=>({reads:analyticsValue(row.reads),searches:analyticsValue(row.searches),bookmarks:analyticsValue(row.bookmarks),participations:analyticsValue(row.participations)});
 return {unit:'events',current:counts(current),previous:counts(previous)};
}
