import {ServiceError} from '../../../galaxy-contracts/src/service-error.mjs';
const fail=(code,status=503)=>{throw new ServiceError(code,status);};
export class OperationsAgentOsClient {
 constructor({url=null,signingKey=null,serviceKey=null,allowInternalHttp=false,fetchImpl=fetch,now=()=>Math.floor(Date.now()/1000)}){
  if(url){const parsed=new URL(url);if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&(allowInternalHttp||['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))||parsed.username||parsed.password||parsed.search||parsed.hash)fail('operations_agentos_configuration_invalid');}
  Object.assign(this,{url:url?.replace(/\/$/,''),signingKey,serviceKey,fetchImpl,now});
 }
 configured(){return !!this.url&&typeof this.signingKey==='string'&&this.signingKey.length>=32;}
 async status(){if(!this.configured())return {state:'not-configured',modelState:'not-configured',framework:'agno',version:'3.1.7'};
  try{const response=await this.fetchImpl(this.url+'/health',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();const data=await response.json();
   if(data.framework!=='agno'||data.version!=='3.1.7'||data.state!=='running')throw Error();
   const conversationVersion=[1,2].includes(data.conversations?.version)?data.conversations.version:null,domains=['overview','governance','messaging','discovery','maintenance'];
   const conversationDomains=conversationVersion&&Array.isArray(data.conversations?.agentIds)?domains.filter(domain=>data.conversations.agentIds.includes('galaxy-conversation-'+domain)):[];
   const transport=data.conversations?.transport,conversationTransport={events:transport?.events===1,cancel:transport?.cancel===1,originalRunLookup:transport?.originalRunLookup===1};
   return {state:'connected',modelState:data.model==='configured'?'configured':'not-configured',configuredDomains:Array.isArray(data.modelSettings?.scenarios)?data.modelSettings.scenarios.filter(x=>x.state==='configured').map(x=>x.domain):undefined,conversationVersion,conversationDomains,conversationTransport,framework:'agno',version:data.version,persistence:data.persistence,queue:data.queue,traces:data.traces};
  }catch{return {state:'unavailable',modelState:'unknown',framework:'agno',version:'3.1.7'};}
 }
 async metadata(path){if(!this.configured()||typeof this.serviceKey!=='string'||this.serviceKey.length<32)fail('operations_agentos_not_configured');
  let response;try{response=await this.fetchImpl(this.url+path,{headers:{authorization:'Bearer '+this.serviceKey},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail('operations_agentos_unavailable');}
  if(!response.ok)fail(response.status===404?'operations_agentos_run_not_found':'operations_agentos_unavailable',response.status===404?404:503);
  const body=await response.text();if(body.length>4*1024*1024)fail('operations_agentos_response_invalid');try{return JSON.parse(body);}catch{fail('operations_agentos_response_invalid');}
 }
}
