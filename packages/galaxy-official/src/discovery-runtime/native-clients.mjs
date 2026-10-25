import {ServiceError} from '../shared/service-error.mjs';
import {discoveryPagePaths} from './purpose.mjs';
import {controlledNativeSettings} from '../shared/operations-search-quality-schema.mjs';
export const discoveryBusinessEvents=Object.freeze({reads:'content-view',searches:'search',bookmarks:'content-bookmark',participations:'content-participate'});
const recommendationEvents=Object.freeze({exposures:'content-exposure',clicks:'content-click',bookmarks:'content-bookmark',notInterested:'not-interested'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function origin(value){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Invalid native discovery origin');return url.origin;}
function secret(value){if(typeof value!=='string'||value.trim().length<24||/[\r\n]/.test(value))throw new Error('Explicit nonempty discovery service credential required');return value;}
// Errors deliberately contain neither response bodies nor credentials/URLs.
// Redirects are rejected; a configured internal origin cannot redirect secrets.
class NativeClient{
 constructor({url,headers={},fetch:transport=globalThis.fetch,timeoutMs=10000}){this.origin=origin(url);Object.assign(this,{headers,transport,timeoutMs});}
  async call(path,{method='GET',body,signal,allow404=false,inspectResponse,userAgent=null}={}){
  const timeout=AbortSignal.timeout(this.timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
   const agent=typeof userAgent==='string'&&userAgent.length>=1&&userAgent.length<=512&&/^[\x20-\x7e]+$/.test(userAgent)?userAgent:null;
   let response;try{response=await this.transport(this.origin+path,{method,headers:{...this.headers,...(body===undefined?{}:{'Content-Type':'application/json'}),...(agent?{'User-Agent':agent}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:combined,redirect:'error'});}catch{throw new ServiceError('discovery_engine_unavailable',503);}
  if(allow404&&response.status===404)return null;
  if(!response.ok){const error=new ServiceError(response.status===401||response.status===403?'discovery_engine_authorization_failed':'discovery_engine_failed',503);error.nativeStatus=response.status;throw error;}
  inspectResponse?.(response);
  if(response.status===204)return null;
  try{return await response.json();}catch{throw new ServiceError('discovery_engine_response_invalid',503);}
 }
}
export class MeilisearchClient extends NativeClient{
 constructor({url,apiKey,index='galaxy_public_community',...options}){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(index))throw new Error('Invalid public community index');super({url,headers:{Authorization:'Bearer '+secret(apiKey)},...options});this.index=index;}
 async task(result){if(!Number.isInteger(result?.taskUid))throw new ServiceError('discovery_engine_response_invalid',503);const end=Date.now()+60000;while(Date.now()<end){const task=await this.call('/tasks/'+result.taskUid);if(task.status==='succeeded')return task;if(['failed','canceled'].includes(task.status))throw new ServiceError('discovery_index_task_failed',503);await pause(100);}throw new ServiceError('discovery_index_task_pending',503);}
 async configure(){if(await this.call('/indexes/'+this.index,{allow404:true}))return {preserved:true};await this.task(await this.call('/indexes',{method:'POST',body:{uid:this.index,primaryKey:'id'}}));return this.task(await this.call('/indexes/'+this.index+'/settings',{method:'PATCH',body:{searchableAttributes:['title','body','topic','tags'],displayedAttributes:['id','kind','sourceId','version'],filterableAttributes:['id','kind','topic'],sortableAttributes:['publishedAt'],rankingRules:['words','typo','proximity','attribute','sort','exactness']}}));}
 async settings(){return controlledNativeSettings(await this.call('/indexes/'+this.index+'/settings'));}
 async submitSettings(settings){const value=await this.call('/indexes/'+this.index+'/settings',{method:'PATCH',body:controlledNativeSettings(settings)});if(!Number.isSafeInteger(value?.taskUid)||value.taskUid<0)throw new ServiceError('discovery_engine_response_invalid',503);return value.taskUid;}
 async settingsTask(id){if(!Number.isSafeInteger(id)||id<0)throw new ServiceError('invalid_search_quality_request',400);const value=await this.call('/tasks/'+id,{allow404:true});if(value===null)return null;const task=this.validateSettingsTask(value);if(task.id!==id)throw new ServiceError('discovery_engine_response_invalid',503);return task;}
 validateSettingsTask(value){if(!Number.isSafeInteger(value?.uid)||value.uid<0||value.type!=='settingsUpdate'||value.indexUid!==this.index||!['enqueued','processing','succeeded','failed','canceled'].includes(value.status))throw new ServiceError('discovery_engine_response_invalid',503);return {id:value.uid,status:value.status,settings:value.details&&Object.hasOwn(value.details,'synonyms')&&Object.hasOwn(value.details,'rankingRules')?controlledNativeSettings(value.details):null};}
 async settingsTasks({afterId=-1,limit=100,pendingOnly=false}={}){if(!Number.isSafeInteger(afterId)||afterId< -1||!Number.isInteger(limit)||limit<1||limit>100)throw new ServiceError('invalid_search_quality_request',400);const value=await this.call('/tasks?'+new URLSearchParams({indexUids:this.index,types:'settingsUpdate',limit:String(limit),...(pendingOnly?{statuses:'enqueued,processing'}:{})}));if(!Array.isArray(value?.results)||value.results.length>limit||value.next!==null&&!Number.isSafeInteger(value.next))throw new ServiceError('discovery_engine_response_invalid',503);const rows=value.results.map(row=>this.validateSettingsTask(row));if(new Set(rows.map(row=>row.id)).size!==rows.length||rows.some((row,index)=>index>0&&row.id>=rows[index-1].id))throw new ServiceError('discovery_engine_response_invalid',503);return {items:rows.filter(row=>row.id>afterId),complete:rows.length<limit||value.next===null||rows.at(-1)?.id<=afterId};}
 upsert(document){return this.call('/indexes/'+this.index+'/documents',{method:'POST',body:[document]}).then(value=>this.task(value));}
 remove(key){return this.call('/indexes/'+this.index+'/documents/'+encodeURIComponent(key),{method:'DELETE'}).then(value=>this.task(value));}
 search({query,topic,after,limit,itemKeys,rankingMode}){const filter=[];if(topic)filter.push('topic = '+JSON.stringify(topic));if(itemKeys)filter.push('id IN '+JSON.stringify(itemKeys));return this.call('/indexes/'+this.index+'/search',{method:'POST',body:{q:query,offset:after,limit,attributesToRetrieve:['id','kind','sourceId','version'],...(rankingMode==='newest'?{sort:['publishedAt:desc']}:{}),...(filter.length?{filter}:{})}});}
 health(){return this.call('/health');}
}
export class GorseClient extends NativeClient{
 constructor({url,apiKey,...options}){super({url,headers:{'X-API-Key':secret(apiKey)},...options});}
 upsert(document){return this.call('/api/items',{method:'POST',body:[{ItemId:document.id,IsHidden:false,Categories:[document.topic],Timestamp:new Date(document.publishedAt*1000).toISOString(),Labels:{tags:document.tags,topic:document.topic},Comment:''}]});}
 remove(key){return this.call('/api/item/'+encodeURIComponent(key),{method:'DELETE',allow404:true});}
 async feedback(event){if(!event.itemKey||event.name==='content-exposure')return {ignored:true};const types={'content-view':'view','content-click':'click','search-click':'click','content-bookmark':'bookmark','content-participate':'participate','not-interested':'not-interested'},type=types[event.name];if(!type)return {ignored:true};await this.call('/api/user',{method:'POST',body:{UserId:event.profileId,Labels:[],Comment:''}});return this.call('/api/feedback',{method:'PUT',body:[{FeedbackType:type,UserId:event.profileId,ItemId:event.itemKey,Timestamp:event.occurredAt,Value:1}]});}
 async recommend({profileId,mode,topic,limit,offset=0}){
  const params=new URLSearchParams({n:String(limit),offset:String(offset)});if(topic)params.set('category',topic);
  const value=await this.call((mode==='latest'?'/api/latest':'/api/recommend/'+encodeURIComponent(profileId))+'?'+params);
  if(!Array.isArray(value)||value.length>limit)throw new ServiceError('discovery_engine_response_invalid',503);
  // Keep the native page length intact: silently dropping malformed rows would
  // move the next offset backwards and could mistake a partial page for its end.
  return value.map(item=>{const id=typeof item==='string'?item:item?.Id??item?.ItemId??item?.id;if(typeof id!=='string')throw new ServiceError('discovery_engine_response_invalid',503);return{id,source:mode==='latest'?'gorse-latest':'gorse-recommendation'};});
 }
 health(){return this.call('/api/health/ready');}
}
export class OpenPanelClient extends NativeClient{
 constructor({url,clientId,clientSecret,readClientId,readClientSecret,projectId,...options}){
  super({url,headers:{'openpanel-client-id':secret(clientId),'openpanel-client-secret':secret(clientSecret)},...options});
  this.reader=new NativeClient({url,headers:{'openpanel-client-id':secret(readClientId),'openpanel-client-secret':secret(readClientSecret)},...options});
  if(!/^[0-9a-f-]{36}$/.test(projectId))throw new Error('Explicit OpenPanel project required');this.projectId=projectId;
 }
 track(event){
  const properties={galaxy_event_id:event.eventId,purpose:'site-usage-analytics',page_key:event.pageKey,__path:discoveryPagePaths[event.pageKey],__timestamp:event.occurredAt,__deviceId:event.visitorId,
   ...(event.itemKey?{content_id:event.itemKey,content_version:event.sourceVersion,topic:event.topic}:{}),...(event.query===undefined?{}:{query:event.query}),...(event.exposureId?{exposure_id:event.exposureId}:{}),
   ...(event.recommendation?{galaxy_recommendation_request:event.recommendation.requestId,galaxy_policy_version:event.recommendation.policyVersion??'none',galaxy_placement:event.recommendation.placement,galaxy_position:event.recommendation.position,galaxy_candidate_source:event.recommendation.candidateSource,galaxy_theme_keys:JSON.stringify(event.recommendation.themeKeys)}:{}),
   ...(event.search?{galaxy_search_request:event.search.requestId,galaxy_search_measured:'true',galaxy_search_result:event.search.resultState,galaxy_search_version:event.search.configurationVersion??'none',query:event.search.query,...(event.search.position?{galaxy_search_position:event.search.position}:{})}:{})};
  return this.call('/track',{method:'POST',userAgent:event.transport?.kind==='website-http'?event.transport.userAgent:null,body:{type:'track',payload:{name:event.name==='pageview'?'screen_view':event.name,profileId:event.profileId,properties}}});
 }
 async businessCounts({startDate,endDate}){
  // Public 2.x's authenticated chart query calls its own ChartEngine. Event
  // segment COUNT(*) and the native metrics.sum cover the complete window;
  // neither raw-event pagination nor the top-path subset supplies a total.
  const query=new URLSearchParams({projectId:this.projectId,startDate,endDate,interval:'day',range:'7d',previous:'false',breakdowns:'[]',series:JSON.stringify(Object.values(discoveryBusinessEvents).map(name=>({name,segment:'event',filters:[{id:'A',name:'properties.purpose',operator:'is',value:['site-usage-analytics']}]})))});
  const value=await this.reader.call('/export/charts?'+query);
  if(!Array.isArray(value?.series))throw new ServiceError('discovery_engine_response_invalid',503);
  return Object.fromEntries(Object.entries(discoveryBusinessEvents).map(([key,name])=>{
   const matches=value.series.filter(row=>row?.event?.name===name),count=matches.length===1?matches[0]?.metrics?.sum:undefined;
   // A missing series is unknown. Only an explicit native numeric zero is 0.
   return [key,Number.isSafeInteger(count)&&count>=0?count:null];
  }));
 }
 async recommendationReport({startDate,endDate}){
  const filters=[{id:'A',name:'properties.purpose',operator:'is',value:['site-usage-analytics']},{id:'B',name:'properties.galaxy_placement',operator:'is',value:['home-public-recommendations']}];
  const query=new URLSearchParams({projectId:this.projectId,startDate,endDate,interval:'day',range:'30d',previous:'false',breakdowns:'[]',series:JSON.stringify(Object.values(recommendationEvents).map(name=>({name,segment:'event',filters})))});
  const value=await this.reader.call('/export/charts?'+query);if(!Array.isArray(value?.series))throw new ServiceError('discovery_engine_response_invalid',503);
  const metrics={},dates=new Map(),integer=value=>Number.isSafeInteger(value)&&value>=0;
  for(const[key,name]of Object.entries(recommendationEvents)){
   const rows=value.series.filter(row=>row?.event?.name===name),row=rows.length===1?rows[0]:null;metrics[key]=integer(row?.metrics?.sum)?row.metrics.sum:null;
   if(!row||!Array.isArray(row.data))continue;const seen=new Set();
   for(const point of row.data){const date=typeof point?.date==='string'?/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.exec(point.date)?.[0].slice(0,10):null;
    if(!date||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!integer(point.count)||seen.has(date))continue;seen.add(date);if(!dates.has(date))dates.set(date,{date,...Object.fromEntries(Object.keys(recommendationEvents).map(key=>[key,null]))});dates.get(date)[key]=point.count;
   }
  }
  const items=[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date));return {metrics,trend:{items,availability:items.length?'available':'not-collected'}};
 }
 async searchQualityReport({startDate,endDate}){
  const purpose={id:'A',name:'properties.purpose',operator:'is',value:['site-usage-analytics']},measured={id:'B',name:'properties.galaxy_search_measured',operator:'is',value:['true']};
  const definitions=[{id:'galaxy-searches',name:'search',segment:'event',filters:[purpose]},{id:'galaxy-no-results',name:'search',segment:'event',filters:[purpose,measured,{id:'C',name:'properties.galaxy_search_result',operator:'is',value:['no-results']}]},{id:'galaxy-clicks',name:'search-click',segment:'event',filters:[purpose,measured]}];
  const query=new URLSearchParams({projectId:this.projectId,startDate,endDate,interval:'day',range:'7d',previous:'false',breakdowns:'[]',series:JSON.stringify(definitions)}),value=await this.reader.call('/export/charts?'+query);
  if(!Array.isArray(value?.series))throw new ServiceError('discovery_engine_response_invalid',503);
  const metrics={},dates=new Map(),names={searches:'galaxy-searches',noResults:'galaxy-no-results',clicks:'galaxy-clicks'},integer=value=>Number.isSafeInteger(value)&&value>=0;
  // public2 format.ts preserves definition.id under event.id even when series
  // share the event name and are re-sorted by their sums.
  for(const[key,id]of Object.entries(names)){const rows=value.series.filter(row=>row?.event?.id===id),row=rows.length===1?rows[0]:null;metrics[key]=integer(row?.metrics?.sum)?row.metrics.sum:null;if(!Array.isArray(row?.data))continue;
   const seen=new Set();for(const point of row.data){const date=typeof point?.date==='string'?/^\d{4}-\d{2}-\d{2}(?:$|[ T])/.exec(point.date)?.[0].slice(0,10):null;if(!date||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!integer(point.count)||seen.has(date))continue;seen.add(date);if(!dates.has(date))dates.set(date,{date,searches:null,noResults:null,clicks:null});dates.get(date)[key]=point.count;}
  }
  const items=[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date));return {metrics,trend:{items,availability:items.length?'available':'not-collected'}};
 }
 // These are the native public-2.x authenticated Insights handlers. They reuse
 // OpenPanel's query engine directly; Galaxy does not recompute cohorts/paths.
 tool(name,args={},options={}){
  const routes={get_analytics_overview:'overview',get_retention_cohort:'retention/cohort',get_user_flow:'user_flow',query_events:'events',get_profile_metrics:'profiles/'+encodeURIComponent(args.profileId??'')+'/metrics',get_profile_sessions:'profiles/'+encodeURIComponent(args.profileId??'')+'/sessions'};
  if(!Object.hasOwn(routes,name))throw new ServiceError('discovery_analysis_not_supported',400);
  const query=new URLSearchParams();for(const[key,value]of Object.entries(args)){if(key==='profileId'&&name!=='query_events'||value===undefined)continue;query.set(key,typeof value==='object'?JSON.stringify(value):String(value));}
  return this.reader.call('/insights/'+this.projectId+'/'+routes[name]+(query.size?'?'+query:''),options);
 }
 async accountAnalysis(name,args={}){
  if(!['get_retention_cohort','get_user_flow'].includes(name))throw new ServiceError('discovery_analysis_not_supported',400);
  let timezone=null;
  const data=await this.tool(name,{...args,scope:'accounts'},{inspectResponse:response=>{
   // A pre-patch native route can silently ignore an unknown query. Never
   // label that mixed result as account analysis, including after a rollback.
   if(response.headers.get('X-Galaxy-Analytics-Scope')!=='accounts'||response.headers.get('X-Galaxy-Analytics-Account-Id')!==(args.accountId??null))throw new ServiceError('discovery_analysis_scope_unavailable',503);
   const value=response.headers.get('X-Galaxy-Analytics-Timezone');
   if(value!==null){try{new Intl.DateTimeFormat('en',{timeZone:value});timezone=value;}catch{throw new ServiceError('discovery_engine_response_invalid',503);}}
  }});
  if(name==='get_retention_cohort'?!Array.isArray(data):!data||!Array.isArray(data.nodes)||!Array.isArray(data.links))throw new ServiceError('discovery_engine_response_invalid',503);
  return {data,timezone};
 }
 async eventObserved(event){const value=await this.tool('query_events',{properties:{galaxy_event_id:event.eventId},limit:1,startDate:event.occurredAt,endDate:new Date(Date.now()+60000).toISOString()});const visit=(node,depth=0)=>depth<8&&node&&typeof node==='object'&&(node.properties?.galaxy_event_id===event.eventId||Object.values(node).some(child=>visit(child,depth+1)));return !!visit(value);}
 health(){return this.call('/healthcheck');}
}
