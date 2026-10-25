import {z} from 'zod';
import {discoveryEvent,discoveryItemKey,discoveryItemReference} from './purpose.mjs';
import {recommendationThemeMatches,recommendationQueryMatches} from './recommendation-control.mjs';

const limits=Object.freeze({events:2000,authored:200,requests:200,sourceRefs:200,topics:100});
const signalKeys=['views','clicks','bookmarks','participations','publicPosts','publicReplies','searches','notInterested'];
const recommendationKeys=['returnedCandidates','exposures','clicks','bookmarks','participations','notInterested'];
const eventSignal=Object.freeze({'content-view':'views','content-click':'clicks','search-click':'clicks','content-bookmark':'bookmarks','content-participate':'participations','not-interested':'notInterested'});
const recSignal=Object.freeze({'content-exposure':'exposures','content-click':'clicks','content-bookmark':'bookmarks','content-participate':'participations','not-interested':'notInterested'});
const iso=value=>new Date(value).toISOString();
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:null;
const uuid=value=>typeof value==='string'&&z.uuid().safeParse(value).success;
const key=value=>typeof value==='string'&&/^(category:(technology|arts|learning|life|galaxy|unclassified)|(tag|theme):[a-f0-9-]{36})$/.test(value);
const sourceCodes=['public-content-use','public-authoring','public-search','gorse-returned-candidates','recommendation-attribution'];

function acceptedEvent(row,accountId){
 const p=object(row.payload);if(!p||row.account_id!==accountId||row.profile_id!=='account:'+accountId||p.accountId!==accountId||p.profileId!==row.profile_id||p.eventId!==row.id||p.name!==row.name||row.purpose!=='site-usage-analytics'||p.purpose!==row.purpose)return null;
 try{
  const input=Object.fromEntries(['eventId','name','pageKey','content','query','exposureId'].filter(name=>Object.hasOwn(p,name)).map(name=>[name,p[name]]));
  for(const name of ['recommendation','search'])if(Object.hasOwn(p,name))input[name]={requestId:p[name]?.requestId};
  const value=discoveryEvent(input);
  if(value.content&&(p.itemKey!==discoveryItemKey(value.content.kind,value.content.id)||p.sourceVersion!==value.content.version))return null;
  return {...value,itemKey:p.itemKey??null,sourceVersion:p.sourceVersion??null,at:iso(row.created_at),attribution:object(p.recommendation)};
 }catch{return null;}
}
function bucket(theme,method,keys){return {key:theme.key,label:theme.label,summary:'',method,sourceTypes:[],[keys===signalKeys?'signalCounts':'counts']:Object.fromEntries(keys.map(name=>[name,0])),firstObservedAt:null,lastObservedAt:null};}
function observe(row,field,at,source){
 const counts=row.signalCounts??row.counts;counts[field]++;
 if(!row.sourceTypes.includes(source))row.sourceTypes.push(source);
 if(!row.firstObservedAt||at<row.firstObservedAt)row.firstObservedAt=at;
 if(!row.lastObservedAt||at>row.lastObservedAt)row.lastObservedAt=at;
}
function topics(map,mode){
 return [...map.values()].filter(row=>mode!=='interests'||Object.entries(row.signalCounts).some(([field,count])=>!['searches','notInterested'].includes(field)&&count>0)).sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')||a.key.localeCompare(b.key)).map(row=>{
  const c=row.signalCounts??row.counts;
  row.summary=mode==='needs'?`本期有 ${c.searches} 次公开搜索匹配此主题`:mode==='recommendations'?`返回候选 ${c.returnedCandidates} 项，已记录展示 ${c.exposures} 次`:
   `本期浏览 ${c.views} 次、点击 ${c.clicks} 次、收藏 ${c.bookmarks} 次、参与 ${c.participations} 次，公开发表 ${c.publicPosts+c.publicReplies} 条`;
  return row;
 });
}
function basis(period,complete=true,reasons=[]){return {source:'galaxy-normal-purpose-ledger',population:'single-account',purpose:'normal-public-use-profile',qualification:'current-anonymous-public-reader-and-exact-version',aggregation:'category-and-explicit-theme-map',unit:'observations',complete,period,limits:{...limits},reasonCodes:reasons};}
export function emptyAccountProfileAnalysis(period,state='not-connected',recommendationState=state){
 return {profile:{state,interests:[],needs:[],sourceTypes:[],updatedAt:null,validUntil:null,period,basis:basis(period,false,[state])},
  recommendations:{state:recommendationState,categories:[],updatedAt:null,period,basis:{...basis(period,false,[recommendationState]),source:'issued-recommendations-and-attributed-events',scope:'recorded-returned-candidates',doesNotIssueRecommendations:true}}};
}

/** Read-only observations, deliberately independent of the candidate-issuing reader. */
export class DiscoveryAccountProfile{
 constructor({db,endpoint,source,recommendations,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,source,recommendations,now});}
 async read(accountId,{period,canReadRecommendations=false}){
  if(!this.source?.load||!this.recommendations?.catalogWithin)return {...emptyAccountProfileAnalysis(period,'not-connected',canReadRecommendations?'not-connected':'not-authorized'),readExpiresAt:this.now()+30};
  const profileId='account:'+accountId,reasons=[];
  const catalog=(await this.recommendations.catalogWithin(this.db)).filter(theme=>theme.enabled&&key(theme.key)&&typeof theme.label==='string'&&theme.label.length<=200);
  if(catalog.length>1000)return {...emptyAccountProfileAnalysis(period,'partial',canReadRecommendations?'partial':'not-authorized'),readExpiresAt:this.now()+30};
  const rawEvents=(await this.db.query(`SELECT id,account_id,profile_id,name,purpose,payload,created_at FROM discovery_usage_events_v1
   WHERE endpoint=$1 AND account_id=$2 AND profile_id=$3 AND purpose='site-usage-analytics' AND created_at>=$4 AND created_at<=$5 ORDER BY created_at,id LIMIT $6`,[this.endpoint,accountId,profileId,period.from,period.to,limits.events+1])).rows;
  const authored=(await this.db.query(`SELECT * FROM (
   SELECT 'post' AS kind,id,current_version_id::text AS version,created_at FROM forum_posts_v1 WHERE account_id=$1 AND created_at>=$2 AND created_at<=$3
   UNION ALL SELECT 'reply',id,revision::text,created_at FROM forum_replies_v1 WHERE account_id=$1 AND created_at>=$2 AND created_at<=$3
   ) authored ORDER BY created_at,kind,id LIMIT $4`,[accountId,period.from,period.to,limits.authored+1])).rows;
  if(rawEvents.length>limits.events)reasons.push('event-window-too-large');if(authored.length>limits.authored)reasons.push('public-authoring-window-too-large');
  const events=rawEvents.slice(0,limits.events).map(row=>acceptedEvent(row,accountId)).filter(Boolean);
  const eventKeys=[...new Set(events.map(event=>event.itemKey).filter(Boolean))],negatives=new Set((await this.db.query('SELECT item_key FROM discovery_feedback_v1 WHERE endpoint=$1 AND profile_id=$2 AND negative AND item_key=ANY($3::text[])',[this.endpoint,profileId,eventKeys])).rows.map(row=>row.item_key));
  if(events.length<Math.min(rawEvents.length,limits.events))reasons.push('unqualified-event-records-excluded');
  const requestIds=[...new Set(events.map(event=>event.recommendation?.requestId).filter(uuid))];
  let requests=[];
  if(canReadRecommendations){
   requests=(await this.db.query(`SELECT id,profile_id,mode,placement,items,created_at FROM discovery_recommendation_requests_v1
    WHERE endpoint=$1 AND profile_id=$2 AND ((created_at>=$3 AND created_at<=$4) OR id=ANY($5::uuid[])) ORDER BY created_at,id LIMIT $6`,[this.endpoint,profileId,period.from,period.to,requestIds,limits.requests+1])).rows;
  }
  const recReasons=requests.length>limits.requests?['recommendation-window-too-large']:[];
  const refs=new Map(),addRef=ref=>{if(ref)refs.set(discoveryItemKey(ref.kind,ref.id),{kind:ref.kind,id:ref.id});};
  for(const event of events)addRef(event.content);for(const row of authored.slice(0,limits.authored))addRef(row);
  const requestItems=new Map();
  for(const request of requests.slice(0,limits.requests)){
   if(!Array.isArray(request.items)||request.items.length>30||!['personalized','latest'].includes(request.mode)||request.placement!=='home-public-recommendations'){recReasons.push('invalid-recommendation-record');continue;}
   const items=new Map();let valid=true;
   for(const raw of request.items){
    const ref=discoveryItemReference(raw?.key);
    if(!ref||ref.kind!==raw.kind||ref.id!==raw.id||!Number.isInteger(raw.position)||raw.position<1||raw.position>30||items.has(raw.key)||!(uuid(raw.sourceVersion)||typeof raw.sourceVersion==='string'&&/^[1-9][0-9]{0,9}$/.test(raw.sourceVersion))||!['gorse-recommendation','gorse-latest'].includes(raw.candidateSource)){valid=false;break;}
    items.set(raw.key,raw);addRef(ref);
   }
   if(valid)requestItems.set(request.id,{at:iso(request.created_at),items});else recReasons.push('invalid-recommendation-record');
  }
  if(refs.size>limits.sourceRefs){
   const value=emptyAccountProfileAnalysis(period,'partial',canReadRecommendations?'partial':'not-authorized');
   value.profile.basis.reasonCodes=['source-window-too-large'];value.recommendations.basis.reasonCodes=['source-window-too-large'];return {...value,readExpiresAt:this.now()+30};
  }
  // A second current-source read also covers withdraw/change during assembly.
  // We retain only the source fields used for these aggregates, never prose.
  const documents=new Map();
  for(const [itemKey,ref] of refs){const value=await this.source.load(ref);documents.set(itemKey,value);}
  for(const [itemKey,ref] of refs){const value=await this.source.load(ref);documents.set(itemKey,value&&value.publishedUntil>this.now()?value:null);}
  const interests=new Map(),needs=new Map(),categories=new Map();
  const apply=(map,theme,field,at,source,method,keys)=>{if(!map.has(theme.key))map.set(theme.key,bucket(theme,method,keys));observe(map.get(theme.key),field,at,source);};
  const matches=document=>catalog.filter(theme=>recommendationThemeMatches(theme,document));
  let excludedSources=0,unmappedSearches=0;
  for(const event of events){
   if(event.name==='search'){
    const selected=catalog.filter(theme=>recommendationQueryMatches(theme,event.query));if(!selected.length)unmappedSearches++;
    for(const theme of selected)apply(needs,theme,'searches',event.at,'public-search','explicit-query-theme-map-v1',signalKeys);
    continue;
   }
   if(!event.content)continue;
   const document=documents.get(event.itemKey);
   if(!document||document.version!==event.sourceVersion){excludedSources++;continue;}
   const themes=matches(document),field=eventSignal[event.name];
   if(field&&(!negatives.has(event.itemKey)||field==='notInterested'))for(const theme of themes)apply(interests,theme,field,event.at,'public-content-use','qualified-topic-observation-v1',signalKeys);
   const attribution=event.attribution,request=requestItems.get(attribution?.requestId),item=request?.items.get(event.itemKey),recField=recSignal[event.name];
   if(recField&&item&&item.sourceVersion===event.sourceVersion&&attribution.position===item.position&&attribution.candidateSource===item.candidateSource&&attribution.placement==='home-public-recommendations')for(const theme of themes)apply(categories,theme,recField,event.at,'recommendation-attribution','issued-gorse-categories-v1',recommendationKeys);
  }
  for(const row of authored.slice(0,limits.authored)){
   const document=documents.get(discoveryItemKey(row.kind,row.id));
   if(!document||document.version!==row.version||document.authorAccountId!==accountId){excludedSources++;continue;}
   for(const theme of matches(document))apply(interests,theme,row.kind==='post'?'publicPosts':'publicReplies',iso(row.created_at),'public-authoring','qualified-topic-observation-v1',signalKeys);
  }
  for(const request of requestItems.values()){
   if(request.at<period.from||request.at>period.to)continue;
   for(const item of request.items.values()){
    const document=documents.get(item.key);if(!document||document.version!==item.sourceVersion){excludedSources++;continue;}
    for(const theme of matches(document))apply(categories,theme,'returnedCandidates',request.at,'gorse-returned-candidates','issued-gorse-categories-v1',recommendationKeys);
   }
  }
  const interestRows=topics(interests,'interests'),needRows=topics(needs,'needs'),categoryRows=topics(categories,'recommendations');
  if(interestRows.length>limits.topics||needRows.length>limits.topics)reasons.push('topic-window-too-large');if(categoryRows.length>limits.topics)recReasons.push('topic-window-too-large');
  const now=this.now(),updatedAt=iso(now*1000),profileComplete=reasons.length===0,recComplete=profileComplete&&recReasons.length===0;
  const profile={state:profileComplete?(interestRows.length||needRows.length?'available':'empty'):'partial',interests:interestRows.slice(0,limits.topics),needs:needRows.slice(0,limits.topics),sourceTypes:[...new Set([...interestRows,...needRows].flatMap(row=>row.sourceTypes))],updatedAt,validUntil:null,period,
   basis:{...basis(period,profileComplete,[...new Set(reasons)]),excludedSources,unmappedSearches,negativeFeedback:'current-item-exclusion',selfDeclared:false}};
  const recommendations={state:canReadRecommendations?(recComplete?(categoryRows.length?'available':'empty'):'partial'):'not-authorized',categories:canReadRecommendations?categoryRows.slice(0,limits.topics):[],updatedAt:canReadRecommendations?updatedAt:null,period,
   basis:{...basis(period,recComplete,[...new Set([...reasons,...recReasons])]),source:'issued-recommendations-and-attributed-events',scope:'recorded-returned-candidates',doesNotIssueRecommendations:true}};
  const sourceExpiry=[...documents.values()].filter(Boolean).map(doc=>doc.publishedUntil);
  return {profile,recommendations,readExpiresAt:Math.min(now+30,...sourceExpiry)};
 }
}

// Shared closed summary projection for the Agent bridge. It cannot forward a
// raw provider object, query term, article reference, URL or private payload.
export function projectAccountProfileAnalysis(value){
 const row=object(value)??{},states=['available','empty','partial','unavailable','not-connected','not-authorized','not-analyzed'];
 const stamp=value=>typeof value==='string'&&z.iso.datetime({offset:true}).safeParse(value).success?iso(value):null;
 const projectPeriod=value=>({from:stamp(value?.from),to:stamp(value?.to),timeZone:value?.timeZone==='Asia/Shanghai'?'Asia/Shanghai':null});
 const sourceTypes=value=>Array.isArray(value)?value.filter(item=>sourceCodes.includes(item)):[];
 const counts=(value,keys)=>Object.fromEntries(keys.map(name=>[name,Number.isSafeInteger(value?.[name])&&value[name]>=0?value[name]:null]));
 const rows=(value,mode)=>Array.isArray(value)?value.filter(item=>key(item?.key)&&typeof item.label==='string'&&item.label.length<=200&&['qualified-topic-observation-v1','explicit-query-theme-map-v1','issued-gorse-categories-v1'].includes(item.method)).slice(0,limits.topics).map(item=>({key:item.key,label:item.label,summary:typeof item.summary==='string'?item.summary.slice(0,500):null,method:item.method,sourceTypes:sourceTypes(item.sourceTypes),[mode==='recommendations'?'counts':'signalCounts']:counts(item.counts??item.signalCounts,mode==='recommendations'?recommendationKeys:signalKeys),firstObservedAt:stamp(item.firstObservedAt),lastObservedAt:stamp(item.lastObservedAt)})):[];
 const projectBasis=value=>({source:['galaxy-normal-purpose-ledger','issued-recommendations-and-attributed-events'].includes(value?.source)?value.source:null,population:value?.population==='single-account'?'single-account':null,purpose:value?.purpose==='normal-public-use-profile'?'normal-public-use-profile':null,qualification:value?.qualification==='current-anonymous-public-reader-and-exact-version'?value.qualification:null,aggregation:value?.aggregation==='category-and-explicit-theme-map'?value.aggregation:null,unit:value?.unit==='observations'?'observations':null,complete:typeof value?.complete==='boolean'?value.complete:null,scope:value?.scope==='recorded-returned-candidates'?value.scope:null,doesNotIssueRecommendations:value?.doesNotIssueRecommendations===true,reasonCodes:Array.isArray(value?.reasonCodes)?value.reasonCodes.filter(code=>['not-connected','unavailable','not-authorized','partial','event-window-too-large','public-authoring-window-too-large','source-window-too-large','topic-window-too-large','recommendation-window-too-large','invalid-recommendation-record','unqualified-event-records-excluded'].includes(code)):[],...counts(value,['excludedSources','unmappedSearches']),negativeFeedback:value?.negativeFeedback==='current-item-exclusion'?value.negativeFeedback:null,selfDeclared:value?.selfDeclared===false?false:null});
 const p=object(row.profile)??{},r=object(row.recommendations)??{};
 return {profile:{state:states.includes(p.state)?p.state:'unavailable',interests:rows(p.interests,'interests'),needs:rows(p.needs,'needs'),sourceTypes:sourceTypes(p.sourceTypes),updatedAt:stamp(p.updatedAt),validUntil:null,period:projectPeriod(p.period),basis:projectBasis(p.basis)},
  recommendations:{state:states.includes(r.state)?r.state:'unavailable',categories:rows(r.categories,'recommendations'),updatedAt:stamp(r.updatedAt),period:projectPeriod(r.period),basis:projectBasis(r.basis)}};
}
