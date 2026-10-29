import {ServiceError} from '../../../galaxy-contracts/src/service-error.mjs';
import {controlledNativeSettings} from '../../../galaxy-contracts/src/operations-search-quality-schema.mjs';
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
 async settings(){return controlledNativeSettings(await this.call('/indexes/'+this.index+'/settings'));}
 upsert(document){return this.call('/indexes/'+this.index+'/documents',{method:'POST',body:[document]}).then(value=>this.task(value));}
 remove(key){return this.call('/indexes/'+this.index+'/documents/'+encodeURIComponent(key),{method:'DELETE'}).then(value=>this.task(value));}
 health(){return this.call('/health');}
}
export class GorseClient extends NativeClient{
 constructor({url,apiKey,...options}){super({url,headers:{'X-API-Key':secret(apiKey)},...options});}
 upsert(document){return this.call('/api/items',{method:'POST',body:[{ItemId:document.id,IsHidden:false,Categories:[document.topic],Timestamp:new Date(document.publishedAt*1000).toISOString(),Labels:{tags:document.tags,topic:document.topic},Comment:''}]});}
 remove(key){return this.call('/api/item/'+encodeURIComponent(key),{method:'DELETE',allow404:true});}
 health(){return this.call('/api/health/ready');}
}
export class OpenPanelClient extends NativeClient{
 constructor({url,clientId,clientSecret,readClientId,readClientSecret,projectId,...options}){
  super({url,headers:{'openpanel-client-id':secret(clientId),'openpanel-client-secret':secret(clientSecret)},...options});
  this.reader=new NativeClient({url,headers:{'openpanel-client-id':secret(readClientId),'openpanel-client-secret':secret(readClientSecret)},...options});
  if(!/^[0-9a-f-]{36}$/.test(projectId))throw new Error('Explicit OpenPanel project required');this.projectId=projectId;
 }
 // These are the native public-2.x authenticated Insights handlers. They reuse
 // OpenPanel's query engine directly; Galaxy does not recompute cohorts/paths.
 tool(name,args={},options={}){
  const routes={get_analytics_overview:'overview',get_retention_cohort:'retention/cohort',get_user_flow:'user_flow',query_events:'events',get_profile_metrics:'profiles/'+encodeURIComponent(args.profileId??'')+'/metrics',get_profile_sessions:'profiles/'+encodeURIComponent(args.profileId??'')+'/sessions'};
  if(!Object.hasOwn(routes,name))throw new ServiceError('discovery_analysis_not_supported',400);
  const query=new URLSearchParams();for(const[key,value]of Object.entries(args)){if(key==='profileId'&&name!=='query_events'||value===undefined)continue;query.set(key,typeof value==='object'?JSON.stringify(value):String(value));}
  return this.reader.call('/insights/'+this.projectId+'/'+routes[name]+(query.size?'?'+query:''),options);
 }
 health(){return this.call('/healthcheck');}
}
