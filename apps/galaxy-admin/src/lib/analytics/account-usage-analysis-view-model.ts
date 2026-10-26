import type {AccountLifetimeBasis,AccountLifetimeUsage,AccountUsageAnalysisValue,AccountUsageIdentityBasis,AccountUsagePart,AccountUsagePathsBasis,AccountUsageRetentionBasis,AccountUsageTimeZone} from "../../components/accounts/account-usage-analysis-types";
import type {AnalyticsRetentionData,AnalyticsRetentionRow} from "../../components/analytics/analytics-types";
import {analyticsFlow,analyticsValue} from './analytics-view-model';

const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const iso=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const countKeys=['sessions','screenViews','totalEvents','conversionEvents','uniqueDaysActive'] as const;
const valueKeys=['avgSessionDurationMin','p90SessionDurationMin','avgEventsPerSession','avgTimeBetweenSessionsSec'] as const;
const coverageKeys=['home','community','find','account','help','download'];

function timeZone(value:unknown):AccountUsageTimeZone|null{
 const source=record(value);if(!source||source.source!=='native-project-settings'&&source.source!=='native-clickhouse-default')return null;
 let name=null;
 if(typeof source.name==='string'&&source.name.length<=80){try{name=new Intl.DateTimeFormat('en',{timeZone:source.name}).resolvedOptions().timeZone;}catch{/* An unavailable native timezone stays unknown. */}}
 return {source:source.source,name};
}
function identityBasis(value:Record<string,unknown>,accountId:string):AccountUsageIdentityBasis|null{
 return value.identityScope==='accounts'&&value.population==='single-account-profile'&&value.accountOnly===true&&value.accountId===accountId?{identityScope:'accounts',population:'single-account-profile',accountOnly:true,accountId,timezone:timeZone(value.timezone)}:null;
}
function lifetime(value:unknown):AccountLifetimeUsage|null{
 const source=record(value);if(!source)return null;
 const result={...Object.fromEntries(countKeys.map(key=>[key,integer(source[key])])),...Object.fromEntries(valueKeys.map(key=>[key,analyticsValue(source[key])])),bounceRate:analyticsValue(source.bounceRate)!==null&&Number(source.bounceRate)<=100?Number(source.bounceRate):null,firstSeen:iso(source.firstSeen),lastSeen:iso(source.lastSeen)} as AccountLifetimeUsage;
 if(result.sessions===0){for(const key of valueKeys)result[key]=null;result.bounceRate=null;}
 else if(result.sessions===1)result.avgTimeBetweenSessionsSec=null;
 return result;
}
function retention(value:unknown):AnalyticsRetentionData|null{
 const source=record(value);if(!source||!Array.isArray(source.rows)||!Array.isArray(source.weeks)||source.rows.length>100)return null;
 const weeks=source.weeks.filter((item):item is number=>typeof item==='number'&&Number.isInteger(item)&&item>=0&&item<=12);
 if(new Set(weeks).size!==weeks.length||source.weeks.length!==weeks.length)return null;
 const rows:AnalyticsRetentionRow[]=[];
 for(const raw of source.rows){
  const row=record(raw);if(!row||typeof row.cohort!=='string'||typeof row.average!=='boolean'||!Array.isArray(row.cells))return null;
  if(row.average?row.cohort!=='Weighted Average':!/^\d{4}-\d{2}-\d{2}$/.test(row.cohort)||!Number.isFinite(Date.parse(row.cohort+'T00:00:00Z'))||new Date(row.cohort+'T00:00:00Z').toISOString().slice(0,10)!==row.cohort)return null;
  const cells:AnalyticsRetentionRow['cells']=[];
  for(const rawCell of row.cells){
   const cell=record(rawCell);if(!cell||typeof cell.week!=='number'||!weeks.includes(cell.week)||!['recorded','unknown','not-reached'].includes(String(cell.state)))return null;
   const ratio=analyticsValue(cell.ratio),known=cell.state==='recorded';
   cells.push({week:cell.week,count:known?analyticsValue(cell.count):null,ratio:known&&ratio!==null&&ratio<=1?ratio:null,state:cell.state as 'recorded'|'unknown'|'not-reached'});
  }
  rows.push({cohort:row.cohort,average:row.average,size:analyticsValue(row.size),cells});
 }
 return {rows,weeks};
}
function part<T,B>(value:unknown,read:(data:unknown)=>T|null,basis:(value:Record<string,unknown>)=>B|null):AccountUsagePart<T,B>|null{
 const source=record(value),availability=record(source?.availability),checkedAt=integer(source?.checkedAt),readExpiresAt=integer(source?.readExpiresAt);
 if(!source||!availability||!['available','not-connected','unavailable'].includes(String(availability.state))||checkedAt===null||readExpiresAt===null)return null;
 const state=availability.state as 'available'|'not-connected'|'unavailable',rawBasis=record(source.basis),projectedBasis=state==='available'&&rawBasis?basis(rawBasis):null,data=state==='available'&&projectedBasis?read(source.data):null;
 return {availability:{state:state==='available'&&(!data||!projectedBasis)?'unavailable':state,code:typeof availability.code==='string'?availability.code:null},checkedAt,readExpiresAt,basis:data?projectedBasis:null,data};
}

/** Closed account-only projection. The shared read hook owns the server lease. */
export function accountUsageAnalysis(value:unknown,accountId:string):AccountUsageAnalysisValue|null{
 const source=record(value),checkedAt=integer(source?.checkedAt),readExpiresAt=integer(source?.readExpiresAt);
 if(!source||source.accountId!==accountId||source.source!=='openpanel-native'||source.purpose!=='site-usage-analytics'||source.historicalBackfill!==false||source.metadataOnly!==true||checkedAt===null||readExpiresAt===null)return null;
 const lifetimePart=part(source.lifetime,lifetime,(basis):AccountLifetimeBasis|null=>basis.window==='native-lifetime'&&basis.accountId===accountId?{window:'native-lifetime',accountId}:null);
 const pathsPart=part(source.paths,analyticsFlow,(basis):AccountUsagePathsBasis|null=>{
  const identity=identityBasis(basis,accountId),from=iso(basis.from),to=iso(basis.to);
  return identity&&basis.unit==='account-session-path-transitions'&&basis.scope==='native-top-paths'&&basis.classification==='event-family'&&from&&to&&Date.parse(from)<Date.parse(to)?{...identity,from,to,unit:'account-session-path-transitions',scope:'native-top-paths',classification:'event-family'}:null;
 });
 const retentionPart=part(source.retention,retention,(basis):AccountUsageRetentionBasis|null=>{
  const identity=identityBasis(basis,accountId);
  return identity&&basis.window==='native-last-12-weeks'&&basis.interval==='week'&&basis.criteria==='on_or_after'&&basis.activity==='any-event'&&basis.cohortEntry==='first-qualified-activity-in-window'&&basis.accountPrefixFilterSupported===true?{...identity,window:'native-last-12-weeks',interval:'week',criteria:'on_or_after',activity:'any-event',cohortEntry:'first-qualified-activity-in-window',accountPrefixFilterSupported:true}:null;
 });
 if(!lifetimePart||!pathsPart||!retentionPart)return null;
 return {accountId,source:'openpanel-native',purpose:'site-usage-analytics',coverage:Array.isArray(source.coverage)?source.coverage.filter((item):item is string=>typeof item==='string'&&coverageKeys.includes(item)):[],historicalBackfill:false,metadataOnly:true,checkedAt,readExpiresAt,lifetime:lifetimePart,paths:pathsPart,retention:retentionPart};
}

export function accountUsageUnavailable(part:{availability:{state:string}}|null|undefined){return part?.availability.state==='not-connected'?'使用分析服务尚未接通':'这部分使用分析暂时无法取得';}
