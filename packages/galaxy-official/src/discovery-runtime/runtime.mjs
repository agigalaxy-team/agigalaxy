import {ServiceError} from '../shared/service-error.mjs';
import {discoveryEvent,discoveryParse,discoveryIdentity,discoveryItemReference,discoveryItemKey,discoverySearchSchema,discoveryRecommendationSchema} from './purpose.mjs';
import {PublicCommunitySource} from './public-content-source.mjs';
import {DiscoveryStore} from './store.mjs';
import {MeilisearchClient,GorseClient,OpenPanelClient} from './native-clients.mjs';
import {applyRecommendationControl} from './recommendation-control.mjs';
import {readUsageAnalytics} from './analytics.mjs';
export class DiscoveryRuntime{
 constructor({db,endpoint,forum,accounts,permissions,meili=null,gorse=null,openpanel=null,recommendationOperations=null,searchQuality=null,now=()=>Math.floor(Date.now()/1000),source=null,sourceReadOnly=false,store=null}){Object.assign(this,{db,endpoint,forum,accounts,permissions,meili,gorse,openpanel,recommendationOperations,searchQuality,now});this.source=source??new PublicCommunitySource({db,endpoint,forum,readOnly:sourceReadOnly});this.store=store??new DiscoveryStore({db,endpoint,now});}
 async initialize(){await this.store.initialize();if(this.meili)await this.meili.configure();return this.status();}
 async identity(actor,visitorId){if(!actor)return discoveryIdentity({visitorId});if(actor.kind!=='official-account')throw new ServiceError('discovery_identity_required',401);return this.accounts.runAuthorized(actor,'binding',async db=>{const account=await this.accounts.resolveWithin(db,actor,{lock:false});return discoveryIdentity({accountId:account.id,visitorId});});}
  async recordUsage(actor,visitorId,input,{userAgent=null}={}){const event=discoveryEvent(input),identity=await this.identity(actor,visitorId),at=new Date(this.now()*1000).toISOString();let document=null;if(event.content){document=await this.source.load(event.content);if(!document||document.version!==event.content.version)throw new ServiceError('discovery_source_unavailable',404);}
  let recommendation;if(event.recommendation){if(!this.recommendationOperations)throw new ServiceError('discovery_recommendation_attribution_unavailable',503);recommendation=await this.recommendationOperations.evidence(identity.profileId,event.content,event.recommendation.requestId);}
  let search;if(event.search){if(!this.searchQuality)throw new ServiceError('discovery_search_attribution_unavailable',503);search=await this.searchQuality.evidence(identity.profileId,event);}
   const transport=typeof userAgent==='string'&&userAgent.length>=1&&userAgent.length<=512&&/^[\x20-\x7e]+$/.test(userAgent)?{kind:'website-http',userAgent}:null;
   return this.store.record({...event,...identity,...(search&&event.name==='search'?{eventId:search.requestId}:{}),occurredAt:at,...(transport?{transport}:{}),...(document?{itemKey:document.id,sourceVersion:document.version,topic:document.topic}:{}),...(recommendation?{recommendation}:{}),...(search?{search}:{})});
 }
 async search(input,{itemKeys=null,usageIdentity=null}={}){if(!this.meili)throw new ServiceError('discovery_search_not_connected',503);const request=discoveryParse(discoverySearchSchema,input),plan=this.searchQuality?await this.searchQuality.publicPlan():null,native=await this.meili.search({...request,...(itemKeys?{itemKeys}:{}),...(plan?.rankingMode?{rankingMode:plan.rankingMode}:{}),limit:Math.min(100,request.limit*3)}),items=[];let consumed=0;
  if(!Array.isArray(native?.hits))throw new ServiceError('discovery_engine_response_invalid',503);
  for(const candidate of native.hits){consumed++;if(itemKeys&&!itemKeys.includes(candidate.id))continue;const reference=discoveryItemReference(candidate.id);if(!reference)continue;const document=await this.source.load(reference);if(!document||document.indexVersion!==candidate.version){await this.store.enqueue(reference);continue;}if(request.topic&&document.topic!==request.topic)continue;items.push(this.source.view(document));if(items.length===request.limit+1)break;}
  // No native total, snippets or stale indexed text escape this current-source
  // reader. A full candidate budget offers continuation without claiming
  // another qualified result or reporting the native hit total.
  const scanLimited=items.length<=request.limit&&native.hits.length===Math.min(100,request.limit*3),nextAfter=items.length>request.limit?request.after+consumed-1:scanLimited?request.after+consumed:null;
  let result={items:items.slice(0,request.limit),nextAfter,scanLimited,query:request.query,source:'meilisearch-community',qualification:'current-anonymous-public-reader',checkedAt:this.now(),readExpiresAt:this.now()+15};
  // An attested agent's selected-source search is not a website-user query and
  // never issues an ordinary-use attribution record.
  if(this.searchQuality&&usageIdentity){const identity=await this.identity(usageIdentity.actor,usageIdentity.visitorId),afterPlan=await this.searchQuality.publicPlan(),measuredPlan=plan?.version===afterPlan.version&&plan?.rankingMode===afterPlan.rankingMode?plan:{version:null},search=await this.searchQuality.issueSearch(identity.profileId,request,result,measuredPlan);result={...result,search,items:result.items.map((item,index)=>({...item,search:{requestId:search.requestId,position:index+1}}))};}
  return result;
 }
 async searchSelected(input,selectedReferences){if(!Array.isArray(selectedReferences)||!selectedReferences.length||selectedReferences.length>100)throw new ServiceError('discovery_selected_scope_required',403);const itemKeys=[...new Set(selectedReferences.map(ref=>discoveryItemKey(ref.kind,ref.id)))];return this.search(input,{itemKeys});}
 async recommend(actor,visitorId,input){if(!this.gorse)throw new ServiceError('discovery_recommendations_not_connected',503);const request=discoveryParse(discoveryRecommendationSchema,input),identity=await this.identity(actor,visitorId),excluded=await this.store.excluded(identity.profileId),accepted=[],seen=new Set(),candidateBudget=100,plan=this.recommendationOperations?await this.recommendationOperations.publicPlan(identity.profileId):null,
  controlled=request.mode==='personalized'&&plan?.policy.enabled,target=controlled?Math.min(candidateBudget,request.limit*3):request.limit;let received=0,fallback=false;
  const collect=async mode=>{let offset=0,batchSize=Math.min(candidateBudget,request.limit*3);
   while(accepted.length<target){
    // Reserve only the still-missing slots for a possible latest fallback, not
    // a content ratio. Both sources share one budget, including duplicate and
    // rejected rows; small requests grow their batches instead of repeatedly
    // requesting only three rows per call.
    const reserve=mode==='personalized'?Math.max(0,request.limit-accepted.length):0,limit=Math.min(batchSize,candidateBudget-received-reserve);if(limit<=0)break;
    const candidates=await this.gorse.recommend({...request,mode,profileId:identity.profileId,limit,offset});
    if(!Array.isArray(candidates)||candidates.length>limit)throw new ServiceError('discovery_engine_response_invalid',503);
    received+=candidates.length;offset+=candidates.length;
    for(const candidate of candidates){if(typeof candidate?.id!=='string')throw new ServiceError('discovery_engine_response_invalid',503);if(seen.has(candidate.id))continue;seen.add(candidate.id);if(excluded.has(candidate.id))continue;const reference=discoveryItemReference(candidate.id);if(!reference)continue;const document=await this.source.load(reference);if(!document){await this.store.enqueue(reference);continue;}if(request.topic&&document.topic!==request.topic)continue;accepted.push({document,candidate,mode});if(accepted.length===target)break;}
    if(candidates.length<limit)break;batchSize=Math.min(candidateBudget,batchSize*2);
   }
  };
  await collect(request.mode);if(request.mode==='personalized'&&accepted.length<request.limit&&received<candidateBudget){fallback=true;await collect('latest');}
  const ordered=controlled?applyRecommendationControl(accepted,{...plan}):accepted,selected=[];
  for(const candidate of ordered){
   if(this.recommendationOperations){const reference=discoveryItemReference(candidate.document.id),current=await this.source.load(reference);if(!current||current.indexVersion!==candidate.document.indexVersion||request.topic&&current.topic!==request.topic){await this.store.enqueue(reference);continue;}candidate.document=current;}
   selected.push(candidate);if(selected.length===request.limit)break;
  }
  const attribution=this.recommendationOperations?await this.recommendationOperations.issue(identity.profileId,request.mode,selected,plan):null;
  const items=selected.map(({document,candidate,mode},index)=>({...this.source.view(document),reason:{code:mode==='latest'?'current-new-content':'recommendation-candidate',label:mode==='latest'?'当前公开的新内容':'公开内容推荐',candidateSource:candidate.source},...(attribution?{recommendation:{...attribution,position:index+1,candidateSource:candidate.source}}:{})}));
  return {items,mode:request.mode,fallback,source:'gorse',qualification:'current-anonymous-public-reader',checkedAt:this.now(),readExpiresAt:this.now()+15,...(attribution?{recommendation:attribution}:{})};
 }
 async analytics(actor,input){return readUsageAnalytics(this,actor,input);}
 async status(){return {engines:{openpanel:this.openpanel?'configured':'not-connected',gorse:this.gorse?'configured':'not-connected',meilisearch:this.meili?'configured':'not-connected'},outbox:await this.store.status(),retentionPolicy:'not-configured',automaticPurge:false};}
}
export function createDiscoveryRuntime({config={},...options}){return new DiscoveryRuntime({...options,meili:config.meilisearch?new MeilisearchClient(config.meilisearch):null,gorse:config.gorse?new GorseClient(config.gorse):null,openpanel:config.openpanel?new OpenPanelClient(config.openpanel):null});}

export class DiscoveryWorker{
 constructor(runtime){this.runtime=runtime;}
 async seedBatch(limit=100){const{store,source}=this.runtime,db=store.db,state=(await db.query('SELECT * FROM discovery_index_control_v1 WHERE endpoint=$1',[store.endpoint])).rows[0];if(!state)throw new Error('Discovery runtime not initialized');const rows=await source.candidates({after:state.scan_after,limit});let queued=0;for(const reference of rows)if(await store.reconcile(reference))queued++;const complete=rows.length<limit,last=rows.at(-1);await db.query('UPDATE discovery_index_control_v1 SET scan_after=$2,scan_complete=$3,updated_at=$4 WHERE endpoint=$1',[store.endpoint,complete?'':last.kind+':'+last.id,complete,new Date(store.now()*1000).toISOString()]);return{queued,scanned:rows.length,complete};}
 async indexOne(){const{store,source,meili,gorse}=this.runtime;if(!meili||!gorse)return{state:'not-connected'};await store.queueExpired();const row=await store.claim('discovery_index_outbox_v1');if(!row)return{state:'idle'};try{const reference={kind:row.kind,id:row.source_id},document=await source.load(reference),key=row.kind+'_'+row.source_id;if(document){const{id,kind,sourceId,version,indexVersion,title,body,topic,tags,publishedAt}=document;await meili.upsert({id,kind,sourceId,version:indexVersion,title,body,topic,tags,publishedAt});const current=await source.load(reference);if(!current||current.indexVersion!==indexVersion){await meili.remove(key);await gorse.remove(key);await store.enqueue(reference);await store.completeIndex(row);return{state:'source-changed'};}await gorse.upsert(current);await store.completeIndex(row,{version,expiresAt:current.publishedUntil});return{state:'indexed',kind:row.kind,id:row.source_id};}await meili.remove(key);await gorse.remove(key);await store.completeIndex(row);return{state:'removed',kind:row.kind,id:row.source_id};}catch(error){await store.completeIndex(row,{error:error instanceof ServiceError?error.code:'discovery_worker_failed'});return{state:'failed',code:error instanceof ServiceError?error.code:'discovery_worker_failed'};}}
 async deliverOne(){const{store,source,openpanel,gorse}=this.runtime,row=await store.claim('discovery_delivery_outbox_v1');if(!row)return{state:'idle'};const engine=row.target==='openpanel'?openpanel:gorse;if(!engine){await store.completeDelivery(row,'pending','discovery_engine_not_connected');return{state:'not-connected'};}const event=await store.deliveryEvent(row);if(!event){await store.completeDelivery(row,'excluded');return{state:'excluded'};}
  try{if(event.content){const current=await source.load(event.content);if(!current||current.version!==event.sourceVersion){await store.completeDelivery(row,'excluded');return{state:'source-unavailable'};}}
   // OpenPanel's receipt is queue acceptance, not ClickHouse visibility. After
   // a lost response, confirm the stable event property through its native
   // reader; never blindly re-send an unknown accepted event into analytics.
   if(row.target==='openpanel'&&row.submission_started){const seen=await openpanel.eventObserved(event);await store.completeDelivery(row,seen?'delivered':'result-unknown',seen?null:'discovery_delivery_unconfirmed');return{state:seen?'confirmed':'result-unknown'};}
   if(row.target==='openpanel'){if(!await store.beginSubmission(row))return{state:'lease-lost'};await engine.track(event);}else await engine.feedback(event);await store.completeDelivery(row,'delivered');return{state:'delivered',target:row.target};
  }catch(error){const code=error instanceof ServiceError?error.code:'discovery_delivery_failed';await store.completeDelivery(row,row.target==='openpanel'&&code!=='discovery_engine_authorization_failed'?'result-unknown':'pending',code);return{state:'failed',target:row.target,code};}
 }
}
