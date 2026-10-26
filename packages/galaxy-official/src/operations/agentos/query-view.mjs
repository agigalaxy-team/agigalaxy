import {ServiceError} from "../../shared/service-error.mjs";
import {createHash} from 'node:crypto';
import {businessAuditMetadata} from "../audit/view.mjs";
import {p14ControlsSchema} from "../../shared/p14-rules-schema.mjs";
import {operationsPolicySchemas} from "../../shared/operations-product-schema.mjs";
import {p13ConfigurationSchema} from "../../shared/p13-strategies-schema.mjs";
import {searchQualitySettingsSchema} from "../../shared/operations-search-quality-schema.mjs";
import {normalizeAnalyticsRetention} from "../../shared/analytics-retention.mjs";
import {projectAccountProfileAnalysis} from "../../discovery-runtime/account-profile.mjs";
import {recommendationThemeKeySchema,recommendationDirectionSchema} from "../../shared/operations-recommendation-schema.mjs";
import {agentOsMaintenanceComponentSummary} from "../../shared/operations-agentos-maintenance-summary.mjs";
import {messagingConfigSchema} from "../../shared/operations-messaging-schema.mjs";

const object=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:{};
export const text=x=>typeof x==='string'?x.slice(0,4096):null;
export const number=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
const time=x=>typeof x==='number'&&number(x)!==null?x:typeof x==='string'&&Number.isFinite(Date.parse(x))?x:null;
const code=x=>typeof x==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(x)?x:null;
export function project(value,shape){
 if(shape==='s')return text(value);if(shape==='n')return number(value);if(shape==='b')return typeof value==='boolean'?value:null;
 if(Array.isArray(shape))return Array.isArray(value)?value.slice(0,100).map(row=>project(row,shape[0])):null;
 const row=object(value);return Object.fromEntries(Object.entries(shape).map(([key,spec])=>[key,project(row[key],spec)]));
}
const strings=names=>Object.fromEntries(names.split(' ').filter(Boolean).map(key=>[key,'s']));
const numbers=names=>Object.fromEntries(names.split(' ').filter(Boolean).map(key=>[key,'n']));
const bools=names=>Object.fromEntries(names.split(' ').filter(Boolean).map(key=>[key,'b']));
function recommendationDirections(value){
 if(!Array.isArray(value))return{directions:null,directionsComplete:false};
 const rows=[],seen=new Set();let complete=value.length<=100;
 for(const item of value){
  const key=recommendationThemeKeySchema.safeParse(item?.key),direction=recommendationDirectionSchema.safeParse(item?.direction);
  if(!key.success||!direction.success||seen.has(key.data)){complete=false;continue;}
  seen.add(key.data);if(rows.length<100)rows.push({themeKey:key.data,direction:direction.data});
 }
 return{directions:rows,directionsComplete:complete};
}
const account={...strings('accountId uid displayName subjectType createdAt'),profileRevision:'n',restriction:{...bools('active'),until:'s'}};
const visible=x=>x?.sourceState==='available'&&x?.visibility?.hidden===false;
const visibility={...bools('hidden ownHidden inheritedHidden caseHidden'),version:'n',until:'s'};
export function contentItem(x,{body=false}={}){
 const readable=visible(x),value=project(x,{...strings('kind id postId versionId state sourceState createdAt updatedAt'),version:'n',visibility,curation:{revision:'n',sourceVersion:'n',...bools('appliesToCurrent pinned featured'),topic:'s',tags:[{...strings('id name'),version:'n',enabled:'b'}]}});
 return {...value,title:readable?text(x.title):null,excerpt:readable?text(x.excerpt):null,topic:readable?text(x.topic):null,originalTopic:readable?text(x.originalTopic):null,author:readable?project(x.author,account):null,
  ...(body?{body:readable&&typeof x.body==='string'?x.body.slice(0,12000):null,bodyTruncated:readable&&typeof x.body==='string'?x.body.length>12000:false}:{}),publiclyReadable:readable};
}
export const accountItem=x=>project(x,account);
export const sectionItem=x=>({...project(x,{...strings('id state sourceState category createdAt updatedAt'),version:'n',visibility}),title:visible(x)?text(x.title):null});
export const caseItem=x=>project(x,{...strings('id state createdAt closedAt restrictedUntil'),version:'n',target:{...strings('kind postId versionId replyId'),contentRevision:'n'},currentEffect:{active:'b',until:'s',scope:'s'}});
const caseText=(value,maximum)=>{if(typeof value!=='string')return {value:null,truncated:false};const points=Array.from(value);return {value:points.slice(0,maximum).join(''),truncated:points.length>maximum};};
const caseKinds=['report','supplement','withdraw','appeal','resolve'];
const caseResolution=value=>['dismissed','accepted','needs-review'].includes(value)?value:null;
const caseRestriction=value=>['hide','keep','release'].includes(value)?value:null;
const caseSourceState=value=>value==='available'?'available':'unavailable';
const caseDecision=value=>value?{...project(value,{...strings('id effectUntil createdAt'),version:'n'}),actorKind:['identity','business-operator'].includes(value.actorKind)?value.actorKind:null,resolution:caseResolution(value.resolution),restrictionAction:caseRestriction(value.restrictionAction)}:null;
/** Only the selected P07 service-authorized view, never a case-directory body.
 * Legacy private narratives and parties are deliberately not read here. */
export function caseDetail(x){
 if(x?.legacyPrivateNarrativeGranted!==false||!Array.isArray(x.events)||x.events.length>1000||!['available','unavailable'].includes(x?.source?.availability)
  ||x.source.availability==='available'&&typeof x.source.content?.body!=='string')
  throw new ServiceError('operations_query_response_invalid',503);
 const source=x.source??{},available=source.availability==='available',title=caseText(available?source.content?.title:null,160),body=caseText(available?source.content?.body:null,8000),links=[];
 let linksTruncated=false;
 if(available&&Array.isArray(source.content?.links))for(const item of source.content.links){
  let allowed=false;try{const url=new URL(item);allowed=typeof item==='string'&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&Array.from(item).length<=2048;}catch{}
  if(allowed&&links.length<8)links.push(item);else linksTruncated=true;
 }
 const result={...caseItem(x),handling:{canModerate:typeof x.canModerate==='boolean'?x.canModerate:null,knownPartyConflict:typeof x.knownPartyConflict==='boolean'?x.knownPartyConflict:null},
  source:{availability:caseSourceState(source.availability),locator:project(source.locator,{...strings('kind postId versionId replyId'),contentRevision:'n'}),publishedUntil:number(source.publishedUntil),
   content:available?{title:title.value,body:body.value,links}:null,titleTruncated:title.truncated,bodyTruncated:body.truncated,linksTruncated},
  events:[],initialDecision:caseDecision(x.initialDecision),currentDecision:caseDecision(x.currentDecision),
  material:{purpose:'public-case-review',trust:'untrusted-source-text',instructionAuthority:'none',scope:'current-service-authorized',legacyPrivateNarrativeGranted:false,
   coverage:{sourceAvailable:available,eventsAvailable:x.events.length,eventsReturned:0,eventsComplete:false,textComplete:!title.truncated&&!body.truncated&&!linksTruncated,eventSelection:'all-current-authorized'}}};
 const chosen=[];
 // Keep the initial statement and the most recent authorized records first.
 // A bounded response explicitly reports every omitted event; it is not a
 // complete-case finding and never silently clips a legal source body.
 for(const index of x.events.length?[0,...Array.from({length:x.events.length-1},(_,i)=>x.events.length-1-i)]:[]){
  const event=x.events[index],summary=caseText(event.summary,1600),value={...project(event,{...strings('id createdAt'),version:'n'}),
   kind:caseKinds.includes(event.kind)?event.kind:null,actorKind:['official-account','business-operator'].includes(event.actorKind)?event.actorKind:null,
   summary:summary.value,summaryTruncated:summary.truncated,resolution:caseResolution(event.resolution),restrictionAction:caseRestriction(event.restrictionAction),effectUntil:text(event.effectUntil)};
  if(Buffer.byteLength(JSON.stringify({...result,events:[...chosen.map(item=>item.value),value]}))>120000)continue;
  chosen.push({index,value});
 }
 result.events=chosen.sort((a,b)=>a.index-b.index).map(item=>item.value);
 const coverage=result.material.coverage;coverage.eventsReturned=result.events.length;coverage.eventsComplete=result.events.length===x.events.length;
 coverage.textComplete=coverage.textComplete&&result.events.every(event=>!event.summaryTruncated);
 if(!coverage.eventsComplete)coverage.eventSelection='first-and-latest-within-output-budget';
 return result;
}
// A report's scalar version alone does not change when a current source or
// disclosed event permission expires. Pin the actually authorized set too.
export function caseMaterialVersion(x){
 const source=x?.source??{};
 return createHash('sha256').update(JSON.stringify([x?.version??null,source.locator??null,source.availability??null,source.publishedUntil??null,
  x?.knownPartyConflict??null,x?.legacyPrivateNarrativeGranted??null,
  Array.isArray(x?.events)?x.events.map(event=>[event.id??null,event.version??null,event.kind??null]):null])).digest('hex');
}
export const chatCaseItem=x=>project(x,{...strings('reportId state category createdAt updatedAt closedAt'),version:'n',...numbers('materialCount additionalMaterialCapacity'),materialsExpired:'b',target:{...strings('type id'),version:'n'},ownRestriction:{scopes:['s'],until:'s'}});
export function chatCaseDetail(x){
 if(!Array.isArray(x?.materials)||x.materials.length>20)throw new ServiceError('operations_query_response_invalid',503);
 return{...chatCaseItem(x),materials:x.materials.map(item=>{
  if(item.state==='available'&&typeof item.text!=='string')throw new ServiceError('operations_query_response_invalid',503);
  return{...project(item,{...strings('eventId messageId roomId state sourceExpiresAt sentAt'),revision:'n',moderation:{...numbers('revision sourceRevision'),...Object.fromEntries(['hidden','ownHidden','appliesToCurrent','canHide','canRestore','canKeep'].map(key=>[key,'b']))}}),text:item.state==='available'?item.text:null,
   attachments:(item.attachments??[]).map(file=>project(file,{...strings('attachmentId state mediaType expiresAt'),size:'n',contentAvailable:'b'}))};
 }),material:{purpose:'private-case-review',trust:'untrusted-source-text',instructionAuthority:'none',coverage:'explicit-selected-current-materials'},roomHistoryGranted:false};
}
export const chatCaseMaterialVersion=x=>createHash('sha256').update(JSON.stringify([x?.version??null,(x?.materials??[]).map(item=>[item.eventId,item.messageId,item.revision,item.state,item.sourceExpiresAt,item.moderation?.revision??null])])).digest('hex');
export const feedbackItem=x=>project(x,{...strings('id category module state createdAt updatedAt'),revision:'n',attachmentCount:'n',account});
/** Selected feedback is private source material for this handling task only.
 * Its intake schema bounds are kept whole; oversized/invalid data is rejected,
 * never silently sliced into an apparently complete statement. */
export function feedbackDetail(x){
 if(typeof x?.title!=='string'||x.title.length<1||x.title.length>120||typeof x?.body!=='string'||x.body.length<1||x.body.length>6000)
  throw new ServiceError('operations_query_response_invalid',503);
 return {...feedbackItem(x),title:x.title,body:x.body,titleTruncated:false,bodyTruncated:false,
  material:{purpose:'feedback-processing',trust:'untrusted-source-text',instructionAuthority:'none',coverage:'complete'}};
}

export const fileItem=x=>({...project(x,{...strings('id kind name state processingState scope version processingVersion createdAt uploadedAt expiresAt removedAt revokedAt'),...numbers('size scanAttempts'),...bools('cleanupPending processingAvailable canRetryScan canRetryCleanup'),access:{revision:'n',stopped:'b',until:'n',canStop:'b',canRestore:'b',restoreBlockedReason:'s'},scan:{state:'s',checkedAt:'s'},cleanup:{state:'s',objectRemoved:'b',executionObserved:'b',failureObserved:'b'},accounting:{reservedBytes:'n',actualStoredBytes:'n'}}),lastError:code(x?.lastError)});
const closed=(value,allowed)=>allowed.includes(value)?value:null;
const cleanupReasons=['expired','unreferenced'];
const cleanupResultCodes=['file-unavailable','already-removed','file-changed','references-changed','eligibility-changed','plan-cancelled','object-removed','object-already-absent','operations_permission_denied','business_admin_denied','operations_authorization_unavailable','attachment_service_unavailable','attachment_storage_unavailable','attachment_storage_integrity_failed','operations_file_cleanup_result_unknown','operations_file_cleanup_unavailable'];
export const cleanupCandidateItem=x=>({...project(x,{...strings('id name expiresAt'),...numbers('size referenceCount activeReferences'),eligible:'b'}),kind:closed(x?.kind,['chat','forum']),reason:closed(x?.reason,cleanupReasons),blockedReason:closed(x?.blockedReason,['processing-active','reference-check-incomplete','storage-unavailable'])});
export function cleanupPlanItem(x){
 const value={...project(x,{...strings('id createdAt approvedAt cancelledAt completedAt'),...numbers('revision itemCount declaredBytes'),counts:numbers('pending removing removed skipped result-unknown'),createdBy:{displayName:'s'},approvedBy:{displayName:'s'},impact:{...bools('serverCopyRemoval restorationAvailable'),physicalBlocksReleased:'n'}}),state:closed(x?.state,['awaiting-approval','queued','running','completed','attention','cancelled'])};
 if(Array.isArray(x?.items))value.items=x.items.slice(0,50).map(item=>({...project(item,{...strings('id name expiresAt completedAt'),...numbers('size referenceCount activeReferences attemptCount'),objectRemoved:'b'}),kind:closed(item.kind,['chat','forum']),reason:closed(item.reason,cleanupReasons),state:closed(item.state,['pending','removing','removed','skipped','result-unknown']),resultCode:closed(item.resultCode,cleanupResultCodes),currentState:closed(item.currentState,['prepared','uploading','scan-pending','scanning','available','blocked','erased','revoked'])}));
 return value;
}
export const cleanupOperation=x=>({...project(x,strings('operationId planId')),state:closed(x?.state,['recorded','not-recorded']),kind:closed(x?.kind,['create','approve','cancel'])});
export const resourceItem=x=>({...project(x,{...strings('id kind state sourceState createdAt updatedAt'),version:'n',...bools('deprecated securityIssue'),visibility}),title:visible(x)?text(x.title):null});
const deliveryStates={...numbers('total pending submitting submitted delivered skipped failed unknown blocked bounced opened clicked'),receipts:'s'};
export const messageRun=x=>project(x,{...strings('id planId state errorCode createdAt updatedAt completedAt'),...numbers('revision planVersion'),audience:{accountCount:'n',frozenAt:'s'},delivery:{email:deliveryStates,inapp:deliveryStates},announcement:{...strings('id state publishedAt expiresAt withdrawnAt')}});
export function messagePlan(x){return {...project(x,{...strings('id state effectiveState createdAt updatedAt'),...numbers('version revision')}),channels:Array.isArray(x?.config?.channels)?x.config.channels.filter(v=>['announcement','inapp','email'].includes(v)):[],purpose:text(x?.config?.content?.purpose),expiresAt:text(x?.config?.content?.expiresAt),schedule:project(x?.config?.schedule,{...strings('kind at cron timezone')})};}
export function messageDraft(x){
 const checked=messagingConfigSchema.safeParse(x?.config);
 if(x?.state!=='draft'||!checked.success)throw new ServiceError('operations_query_response_invalid',503);
 // Selected editing material keeps the existing 8,000-character body intact.
 // The general plan directory remains metadata and never copies draft prose.
 return{...messagePlan(x),config:checked.data,contentTrust:'untrusted-source',instructionAuthority:'none'};
}
export const recipientItem=x=>project(x,{...strings('id channel state errorCode retryAt submittedAt completedAt'),attemptCount:'n',...bools('deferred retryable'),account,attempts:[{...numbers('number'),...strings('state errorCode startedAt finishedAt'),networkAttempt:'b'}]});
export const historyItem=x=>project(x,{...strings('id sequence kind createdAt operatorDisplayName'),...numbers('version revision publishedVersion')});
export function auditItem(row){
 const time=typeof row?.createdAt==='string'&&Number.isFinite(Date.parse(row.createdAt))?row.createdAt:null;if(!time)return null;
 const safe=businessAuditMetadata({id:row.id,sequence:row.sequence,action:row.action,operator_id:row.operatorId,operator_display_name:row.operatorDisplayName,operator_role:row.operatorRole,actor_kind:row.actorKind,execution_id:row.executionId,grant_id:row.grantId,account_id:row.accountId,operation_id:row.operationId,http_request_id:null,selection:row.selection,result:row.result,audit_attribution:row.attribution,created_at:time});
 return {...project(safe,{...strings('id sequence action actorKind operatorDisplayName accountId operationId createdAt')}),attribution:{...safe.attribution,initiatorOperatorId:null},selection:safe.selection,result:safe.result};
}
const metrics={...numbers('exposures impressions clicks bookmarks notInterested engagement requests searches measuredSearches resultKnownSearches noResults noResultRate clickedSearches clickRate followUps scanLimited')};
const observed={...strings('target lastAppliedAt'),...numbers('publishedVersion count')};
const availability={state:'s',code:'s'};
const accountUsageNumbers=numbers('sessions screenViews totalEvents conversionEvents uniqueDaysActive avgSessionDurationMin p90SessionDurationMin avgEventsPerSession avgTimeBetweenSessionsSec bounceRate');
// Zero sessions cannot form session rates, averages or quantiles. One session
// cannot form a between-session interval. Other genuine zero values remain zero.
function accountSessionDenominators(value){
 const data=project(value,{...accountUsageNumbers,...strings('firstSeen lastSeen')});
 if(data.sessions===0){for(const key of ['avgSessionDurationMin','p90SessionDurationMin','avgEventsPerSession','avgTimeBetweenSessionsSec','bounceRate'])data[key]=null;}
 else if(data.sessions===1)data.avgTimeBetweenSessionsSec=null;
 return data;
}
const accountUsageEvents=new Set(['screen_view','content-view','content-click','search','search-click','content-bookmark','content-participate']);
function accountUsagePart(value,kind){
 if(!value||typeof value!=='object')return null;
 const part=project(value,{checkedAt:'n',readExpiresAt:'n'}),state=closed(value.availability?.state,['available','not-connected','unavailable']);
 if(!state)return null;
 part.availability={state,code:code(value.availability?.code)};
 part.basis=value.basis===null?null:project(value.basis,{...strings('window accountId identityScope population from to unit scope classification interval criteria activity cohortEntry'),...bools('accountOnly accountPrefixFilterSupported'),timezone:{...strings('source name')}});
 if(value.data===null){part.data=null;return part;}
 if(kind==='lifetime'){part.data=accountSessionDenominators(value.data);return part;}
 if(kind==='paths'){
  const data=value.data,ids=new Set();
  if(Array.isArray(data?.nodes)&&Array.isArray(data?.links)&&data.nodes.length<=100&&data.links.length<=100&&data.nodes.every(node=>/^n(?:0|[1-9][0-9]{0,2})$/.test(node?.id)&&!ids.has(node.id)&&ids.add(node.id)&&accountUsageEvents.has(node.label))&&data.links.every(link=>ids.has(link?.source)&&ids.has(link?.target))){
   part.data=project(data,{nodes:[{...strings('id label'),...numbers('step value percentage')}],links:[{...strings('source target'),value:'n'}]});return part;
  }
 }else{
  const data=value.data;
  if(Array.isArray(data?.rows)&&data.rows.length<=100&&Array.isArray(data?.weeks)&&data.weeks.length<=13&&data.weeks.every(week=>Number.isInteger(week)&&week>=0&&week<=12)&&data.rows.every(row=>(row?.cohort==='Weighted Average'||/^\d{4}-\d{2}-\d{2}$/.test(row?.cohort))&&Array.isArray(row.cells)&&row.cells.length<=13&&row.cells.every(cell=>['recorded','unknown','not-reached'].includes(cell?.state)))){
   part.data={weeks:[...data.weeks],rows:data.rows.map(row=>project(row,{cohort:'s',average:'b',size:'n',cells:[{...numbers('week count ratio'),state:'s'}]}))};return part;
  }
 }
 return {...part,availability:{state:'unavailable',code:'operations_query_response_invalid'},data:null};
}
function accountUsageAnalysis(value){
 if(!value||value.source!=='openpanel-native'||value.purpose!=='site-usage-analytics')return null;
 return {...project(value,{accountId:'s',checkedAt:'n',readExpiresAt:'n',historicalBackfill:'b',metadataOnly:'b'}),source:'openpanel-native',purpose:'site-usage-analytics',
  coverage:Array.isArray(value.coverage)?value.coverage.filter(item=>['home','community','find','account','help','download'].includes(item)):[],
  lifetime:accountUsagePart(value.lifetime,'lifetime'),paths:accountUsagePart(value.paths,'paths'),retention:accountUsagePart(value.retention,'retention')};
}
export function analyticsData(value,kind,{checkedAt=null,basis=null}={}){
 const x=object(value);
 if(kind==='overview'){
  const data=project(x,{summary:{...numbers('unique_visitors total_screen_views total_sessions bounce_rate avg_session_duration views_per_session')},series:[{date:'s',...numbers('unique_visitors total_screen_views total_sessions')}],...strings('interval startDate endDate')});
  if(data.summary.total_sessions===0){for(const key of ['bounce_rate','avg_session_duration','views_per_session'])data.summary[key]=null;}
  return data;
 }
 if(kind==='business')return project(x,{unit:'s',current:numbers('reads searches bookmarks participations'),previous:numbers('reads searches bookmarks participations')});
 if(kind==='retention')return normalizeAnalyticsRetention(value,checkedAt,object(object(basis).timezone).name??null);
 if(kind==='paths')return project(x,{nodes:[{...strings('id label'),...numbers('step value percentage')}],links:[{...strings('source target'),value:'n'}]});
 return accountSessionDenominators(x);
}
const validated=(schema,value)=>{const parsed=schema?.safeParse(value);return parsed?.success?parsed.data:null;};
export function ruleDetail(x){return {...queryProjection.rule(x),activePolicy:validated(x?.key==='business-controls'?p14ControlsSchema:operationsPolicySchemas[x?.key],x?.active?.policy)};}
export function strategyDetail(x){return {...queryProjection.strategies(x),configuration:validated(p13ConfigurationSchema,x?.configuration)};}
export function searchDetail(x){return {...queryProjection.search(x),activeSettings:validated(searchQualitySettingsSchema,x?.configuration?.active?.settings)};}
export const analyticsBasis=x=>project(x,{...strings('from to previousFrom previousTo window interval bounds precision aggregation unit scope population identityRule criteria activity identityScope accountId cohortEntry'),...numbers('windowSeconds'),...bools('accountOnly accountPrefixFilterSupported'),timezone:{...strings('name source')}});
export const queryProjection={
 accountsSummary:x=>project(x,{coverage:'s',days:'n',period:{...strings('from to timeZone')},totals:numbers('accounts person agent organization unknown restricted active')}),
 accountSummary:x=>({...project(x,{accountId:'s',days:'n',period:{...strings('from to timeZone')},usage:{...numbers('activeDays searches bookmarks participation publicContributions'),...strings('lastActivityAt basis publicActivityState publicActivityReason'),dailyActivity:[{date:'s',count:'n'}]},predictions:{participation:{state:'s'},needs:{state:'s'}}}),...projectAccountProfileAnalysis(x),usageAnalysis:accountUsageAnalysis(x?.usageAnalysis)}),
 contentSummary:x=>project(x,{available:'b',...strings('state reason'),...numbers('total visible hidden unavailable posts replies pendingReview trendDays'),daily:[{date:'s',posts:'n',replies:'n'}]}),
 feedbackSummary:x=>project(x,{...numbers('total unclassified pending closed'),byCategory:[{category:'s',count:'n'}]}),
 filesSummary:x=>project(x,{scope:'s',totals:numbers('records reservedBytes actualStoredBytes readyFiles pendingScan scanFailed expired revoked removed cleanupPending cleanupResultUnknown cleanupRunning cleanupFailed'),byKind:[{kind:'s',...numbers('records reservedBytes')}]}),
 messageSummary:x=>project(x,{scope:'s',plans:numbers('total draft active paused stopped'),runs:numbers('total running paused blocked completed cancelled expired'),delivery:{inapp:deliveryStates,email:deliveryStates}}),
 search:x=>project(x,{period:{...strings('from to'),days:'n'},metrics,trend:{availability:'s',items:[{date:'s',...metrics}]},queries:{items:[{...strings('key label'),...metrics,issueCodes:['s']}]},configuration:{revision:'n',active:{id:'s',version:'n'},draft:{id:'s',version:'n'},pending:{...strings('operationId phase errorCode')},native:{state:'s'}},basis:{...strings('source metricsSource unit rates bounds qualityCollection noResult'),historicalBackfill:'b'}}),
 recommendation:x=>({...project(x,{period:{...strings('from to'),days:'n'},metrics,topics:{items:[{...strings('key label kind'),...numbers('demand supply reads searches bookmarks participations exposures clicks notInterested'),direction:'s',availability:{supply:'s',usage:'s'}}]},catalog:{items:[{...strings('id key kind label'),enabled:'b',version:'n',mapping:{categories:['s'],tagIds:['s'],queryTerms:['s']}}]},policy:{version:'n',enabled:'b',controls:{avoidRepetition:'b',avoidConcentration:'b'}},basis:{...strings('metricsSource topicSource recommendationAttribution demandUnit supplyScope'),...bools('historicalBackfill sourceScanComplete')}}),...recommendationDirections(x?.policy?.directions)}),
 rule:x=>project(x,{key:'s',revision:'n',active:{...strings('id key source createdAt'),...numbers('version publishedVersion')},draft:{...strings('id key createdAt'),version:'n'},adoption:{mode:'s',publishedVersion:'n',observed:[observed]}}),
 strategies:x=>project(x,{revision:'n',paused:'b',active:{id:'s',version:'n',createdAt:'s'},draft:{id:'s',version:'n',createdAt:'s'},configuration:{common:{objective:'s',automationEnabled:'b'},domains:[{...strings('domain objective'),priority:'n',executionEnabled:'b'}],strategies:[{...strings('id domain name mode objective templateId'),enabled:'b'}]},native:{state:'s'}}),
 maintenance:x=>{const result=project(x,{components:[{...strings('id label processState processBasis health healthBasis checkedAt processCheckedAt healthCheckedAt code'),processAvailability:availability,healthAvailability:availability}],storage:[{...strings('id kind observedAt'),availability,...numbers('capacityBytes availableBytes usedBytes physicalReclaimedBytes')}],queues:{...strings('scope'),includesAllPlatformQueues:'b',availability,items:[{name:'s',counts:numbers('created retry active completed cancelled failed')}]},errors:{availability,...strings('window scope'),includesAllComponents:'b',count:'n'},maintenanceMode:{...strings('state source'),businessWritesAccepted:'b',revision:'n'},nativeAvailability:availability});return{...result,componentSummary:agentOsMaintenanceComponentSummary(result.components,Array.isArray(x?.components)?x.components.length:null)};},
 point:x=>project(x,{...strings('id createdAt'),...numbers('logicalBytes logicalFileCount'),integrity:{...strings('state checkedAt')},coverage:[{...strings('id label state method'),reasonCodes:['s']}],productionRestore:{available:'b',blockers:['s']}}),
 restorePlan:x=>project(x,{...strings('id state scope productionActivation createdAt updatedAt'),revision:'n',moduleIds:['s'],point:{...strings('id createdAt')},possibleLoss:{...strings('from observedAt through basis'),...numbers('observedWindowSeconds maximumSeconds')},blockers:['s'],openingConditions:[{...strings('id state')}]}),
 job:x=>({...project(x,{...strings('id queue state createdAt startedAt completedAt availableAt resourceId'),...numbers('retryCount retryLimit')}),error:code(x?.error)}),
 role:x=>project(x,{...strings('id name createdAt updatedAt'),enabled:'b',version:'n',permissions:['s']}),
 automation:x=>project(x,{...strings('id name executorKind mode executionState createdAt updatedAt'),...bools('enabled executionAvailable'),version:'n',permissions:['s'],resourceIds:['s']}),
 person:x=>project(x,{...strings('operatorId displayName identityState authorizationState'),assignments:[{...strings('id operatorId roleId createdAt updatedAt'),enabled:'b',version:'n'}],effective:{...strings('version source'),permissions:['s']}}),
 aiRun:x=>({...project(x,{...strings('runId domain state errorCode promptVersion'),durationMs:'n',tokens:numbers('input output total'),conversation:{operatorDisplayName:'s'},executor:{...strings('kind mode onBehalfOfDisplayName')}}),createdAt:time(x?.createdAt),updatedAt:time(x?.updatedAt)}),
};
export const spanItem=x=>({...project(x,{...strings('spanId parentSpanId kind state'),durationMs:'n',tokens:numbers('input output total')}),startTime:time(x?.startTime),endTime:time(x?.endTime)});
