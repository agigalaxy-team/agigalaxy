import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';
import {businessSummaryQuerySchema} from '../../shared/business-admin-schema.mjs';
import {normalizeAnalyticsRetention} from '../../shared/analytics-retention.mjs';

const coverage=Object.freeze(['home','community','find','account','help','download']);
const events=new Set(['screen_view','content-view','content-click','search','search-click','content-bookmark','content-participate']);
const metrics=['sessions','screenViews','totalEvents','conversionEvents','uniqueDaysActive','avgSessionDurationMin','p90SessionDurationMin','avgEventsPerSession','avgTimeBetweenSessionsSec','bounceRate'];
const counts=new Set(['sessions','screenViews','totalEvents','conversionEvents','uniqueDaysActive']);
const nativeFailures=new Set(['discovery_engine_unavailable','discovery_engine_failed','discovery_engine_authorization_failed','discovery_engine_response_invalid','discovery_analysis_scope_unavailable']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:null;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const stamp=value=>typeof value==='string'&&z.iso.datetime({offset:true}).safeParse(value).success?new Date(value).toISOString():null;
const invalid=()=>{throw new ServiceError('discovery_engine_response_invalid',503);};

function timezone(value){
 const row=object(value);if(!row||!['native-project-settings','native-clickhouse-default'].includes(row.source))return null;
 let name=null;
 if(typeof row.name==='string'&&row.name.length<=80){try{name=new Intl.DateTimeFormat('en',{timeZone:row.name}).resolvedOptions().timeZone;}catch{/* Native zone remains unknown. */}}
 return {source:row.source,name};
}

function lifetime(value,accountId){
 const data=object(value);if(!data||data.profileId!=='account:'+accountId)invalid();
 const result=Object.fromEntries(metrics.map(key=>{
  const value=number(data[key]);return[key,value===null||counts.has(key)&&!Number.isSafeInteger(value)||key==='bounceRate'&&value>100?null:value];
 }));
 // Revenue and arbitrary profile properties are deliberately outside this
 // account-usage view. Lifetime counts do not populate selected-day metrics.
 return {...result,firstSeen:stamp(data.firstSeen),lastSeen:stamp(data.lastSeen)};
}

function paths(value){
 const row=object(value);if(!row||!Array.isArray(row.nodes)||!Array.isArray(row.links)||row.nodes.length>200||row.links.length>1000)invalid();
 const ids=new Map(),nodes=[];
 for(const raw of row.nodes){
  const item=object(raw);
  if(!item||typeof item.id!=='string'||!item.id||item.id.length>4096||ids.has(item.id)||!events.has(item.label)||!Number.isInteger(item.step)||item.step<1||item.step>10)invalid();
  const id='n'+nodes.length,percentage=number(item.percentage);ids.set(item.id,{id,step:item.step});
  nodes.push({id,label:item.label,step:item.step,value:number(item.value),percentage:percentage!==null&&percentage<=100?percentage:null});
 }
 const links=row.links.map(raw=>{
  const item=object(raw),source=ids.get(item?.source),target=ids.get(item?.target);
  if(!source||!target||target.step<=source.step)invalid();
  return {source:source.id,target:target.id,value:number(item.value)};
 });
 // Only closed event families escape. Native node IDs can contain concrete
 // paths or object IDs, so graph-local IDs replace them before any response.
 return {nodes,links};
}

function sourceBasis(source,kind,accountId,days){
 const value=object(source?.basis);if(!value||source?.kind!==kind||source?.source!=='openpanel-native'||source?.purpose!=='site-usage-analytics')invalid();
 if(kind==='account'){
  if(value.window!=='native-lifetime'||value.accountId!==accountId)invalid();
  return {window:'native-lifetime',accountId};
 }
 if(value.identityScope!=='accounts'||value.population!=='single-account-profile'||value.accountOnly!==true||value.accountId!==accountId)invalid();
 const common={identityScope:'accounts',population:'single-account-profile',accountOnly:true,accountId,timezone:timezone(value.timezone)};
 if(kind==='retention'){
  if(value.window!=='native-last-12-weeks'||value.interval!=='week'||value.criteria!=='on_or_after'||value.activity!=='any-event'||value.cohortEntry!=='first-qualified-activity-in-window'||value.accountPrefixFilterSupported!==true)invalid();
  return {...common,window:'native-last-12-weeks',interval:'week',criteria:'on_or_after',activity:'any-event',cohortEntry:'first-qualified-activity-in-window',accountPrefixFilterSupported:true};
 }
 const from=stamp(value.from),to=stamp(value.to);
 if(value.unit!=='account-session-path-transitions'||value.scope!=='native-top-paths'||!from||!to||Date.parse(to)-Date.parse(from)!==days*86400000)invalid();
 return {...common,from,to,unit:'account-session-path-transitions',scope:'native-top-paths',classification:'event-family'};
}

/**
 * Account usage facts from existing native readers. This adapter owns no PG
 * transaction: native I/O must run after the account's current authorization
 * and outside BusinessAdmin's public-contribution transaction.
 */
export class OperationsAccountUsageSummary {
 constructor({businessAdmin,discovery=null,now=businessAdmin?.now??(()=>Math.floor(Date.now()/1000))}){
  if(!businessAdmin?.authorizeAction||!businessAdmin?.accountWithin)throw new TypeError('Account usage requires BusinessAdmin authorization');
  Object.assign(this,{businessAdmin,discovery,now});
 }
 async current(operator,accountId){
  const actor=await this.businessAdmin.authorizeAction(operator,'analytics.read');
  await this.businessAdmin.accountWithin(this.businessAdmin.db,accountId);return actor;
 }
 async part(actor,kind,accountId,days){
  const empty=(state,code)=>({availability:{state,code},checkedAt:this.now(),readExpiresAt:this.now()+30,basis:null,data:null});
  if(typeof this.discovery?.analytics!=='function')return empty('not-connected','discovery_analysis_not_connected');
  try{
   const source=await this.discovery.analytics(actor,kind==='account'?{kind,accountId}:{kind,scope:'accounts',accountId,...(kind==='paths'?{days}:{})}),basis=sourceBasis(source,kind,accountId,days);
   if(!Number.isSafeInteger(source.checkedAt)||source.checkedAt<0||source.checkedAt>this.now())invalid();
   const data=kind==='account'?lifetime(source.data,accountId):kind==='paths'?paths(source.data):normalizeAnalyticsRetention(source.data,source.checkedAt,basis.timezone?.name??null);
   if(data===null)invalid();
   return {availability:{state:'available',code:null},checkedAt:source.checkedAt,readExpiresAt:source.checkedAt+30,basis,data};
  }catch(error){
   // Current-management 401/403 and an unavailable authorization service are
   // never softened into a local empty analytics result.
   if(error?.code==='discovery_analysis_not_connected')return empty('not-connected',error.code);
   if(nativeFailures.has(error?.code)&&error.status===503)return empty('unavailable',error.code);
   throw error;
  }
 }
 async get(operator,accountId,input={}){
  const id=z.uuid().safeParse(accountId),query=businessSummaryQuerySchema.safeParse(input);
  if(!id.success||!query.success)throw new ServiceError('invalid_business_admin_request',400);
  accountId=id.data.toLowerCase();const {days}=query.data,actor=await this.current(operator,accountId);
  // Sequential native reads preserve each reader's before/after permission
  // checks without concurrent transactions on a shared test/client connection.
  const lifetime=await this.part(actor,'account',accountId,days),flow=await this.part(actor,'paths',accountId,days),retention=await this.part(actor,'retention',accountId,days);
  await this.current(actor,accountId);const checkedAt=this.now();
  for(const part of [lifetime,flow,retention])if(part.readExpiresAt<=checkedAt){part.availability={state:'unavailable',code:'operations_account_usage_expired'};part.data=null;part.basis=null;part.readExpiresAt=checkedAt+30;}
  return {accountId,source:'openpanel-native',purpose:'site-usage-analytics',coverage:[...coverage],historicalBackfill:false,metadataOnly:true,
   checkedAt,readExpiresAt:Math.min(checkedAt+30,lifetime.readExpiresAt,flow.readExpiresAt,retention.readExpiresAt),lifetime,paths:flow,retention};
 }
}
