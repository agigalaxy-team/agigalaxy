import {createHmac,randomUUID} from 'node:crypto';
import {ServiceError} from "../../shared/service-error.mjs";
import {nativeSseFrames,conversationStreamEvent} from "./conversation-stream.mjs";

const fail=(code,status=503)=>{throw new ServiceError(code,status);};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export class OperationsAgentOsClient {
 constructor({url=null,signingKey=null,serviceKey=null,allowInternalHttp=false,fetchImpl=fetch,now=()=>Math.floor(Date.now()/1000)}){
  if(url){const parsed=new URL(url);if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&(allowInternalHttp||['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)))||parsed.username||parsed.password||parsed.search||parsed.hash)fail('operations_agentos_configuration_invalid');}
  Object.assign(this,{url:url?.replace(/\/$/,''),signingKey,serviceKey,fetchImpl,now});
 }
 configured(){return !!this.url&&typeof this.signingKey==='string'&&this.signingKey.length>=32;}
 token(execution){if(!this.configured())fail('operations_agentos_not_configured');const at=this.now(),head=encode({alg:'HS256',typ:'JWT'}),body=encode({sub:(execution.mode==='conversation'?'conversation:':'execution:')+execution.id,iss:'galaxy-operations',aud:'galaxy-agentos',iat:at,exp:at+60,jti:randomUUID()});
  return head+'.'+body+'.'+createHmac('sha256',this.signingKey).update(head+'.'+body).digest('base64url');}
 async status(){if(!this.configured())return {state:'not-configured',modelState:'not-configured',framework:'agno',version:'3.1.7'};
  try{const response=await this.fetchImpl(this.url+'/health',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();const data=await response.json();
   if(data.framework!=='agno'||data.version!=='3.1.7'||data.state!=='running')throw Error();
   const conversationVersion=[1,2].includes(data.conversations?.version)?data.conversations.version:null,domains=['overview','governance','messaging','discovery','maintenance'];
   const conversationDomains=conversationVersion&&Array.isArray(data.conversations?.agentIds)?domains.filter(domain=>data.conversations.agentIds.includes('galaxy-conversation-'+domain)):[];
   const transport=data.conversations?.transport,conversationTransport={events:transport?.events===1,cancel:transport?.cancel===1,originalRunLookup:transport?.originalRunLookup===1};
   return {state:'connected',modelState:data.model==='configured'?'configured':'not-configured',configuredDomains:Array.isArray(data.modelSettings?.scenarios)?data.modelSettings.scenarios.filter(x=>x.state==='configured').map(x=>x.domain):undefined,conversationVersion,conversationDomains,conversationTransport,framework:'agno',version:data.version,persistence:data.persistence,queue:data.queue,traces:data.traces};
  }catch{return {state:'unavailable',modelState:'unknown',framework:'agno',version:'3.1.7'};}
 }
 async request(execution,path,{form=null,idempotencyKey=null}={}){if(!this.configured())fail('operations_agentos_not_configured');
  const headers={authorization:'Bearer '+this.token(execution)};
  if(form)headers['content-type']='application/x-www-form-urlencoded';
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  let response;try{response=await this.fetchImpl(this.url+path,{method:form?'POST':'GET',headers,body:form?new URLSearchParams(form).toString():undefined,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{fail('operations_agentos_result_unknown');}
  const text=await response.text();if(text.length>4*1024*1024)fail('operations_agentos_response_invalid');
  let result;try{result=JSON.parse(text);}catch{fail('operations_agentos_response_invalid');}
  if(!response.ok){if(result?.error==='agentos_model_not_configured')fail('operations_agentos_model_not_configured');if(response.status===503&&result?.error==='agentos_authority_unavailable')fail('operations_authorization_unavailable');fail(response.status===403?'operations_agentos_authority_changed':'operations_agentos_request_failed',response.status===403?403:503);}
  return result;
 }
 read(execution){return this.request(execution,'/galaxy/executions/'+execution.id);}
 readConversation(conversation){return this.request(conversation,'/galaxy/conversations/'+conversation.id);}
 async runConversation(conversation,{runId,message,stream=false,retryOfRunId=null,retryOfOperationId=null}){
  const base='/agents/galaxy-conversation-'+conversation.domain+'/runs';
  const path=retryOfRunId?base+'/'+encodeURIComponent(retryOfRunId)+'/continue':base;
  const form=retryOfRunId?{regenerate:'true',replace_original:'true',retry_of_operation_id:retryOfOperationId,stream:String(stream),background:'true',session_id:conversation.sessionId}:{message,stream:String(stream),background:'true',session_id:conversation.sessionId};
  if(!stream)return this.request(conversation,path,{idempotencyKey:runId,form});
  const response=await this.conversationStreamRequest(conversation,path,form,{idempotencyKey:runId});
  for await(const frame of nativeSseFrames(response.body)){
   if(typeof frame?.run_id!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(frame.run_id))continue;
   if(frame.session_id!==undefined&&frame.session_id!==conversation.sessionId||frame.agent_id!==undefined&&frame.agent_id!=='galaxy-conversation-'+conversation.domain)fail('operations_agentos_response_invalid');
   // The durable native queue/run exists before this stream event. Closing
   // this observer cannot cancel background generation or create a second run.
   return{run_id:frame.run_id,status:'PENDING'};
  }
  fail('operations_agentos_result_unknown');
 }
 readConversationOperation(conversation,operationId){return this.request(conversation,'/galaxy/conversations/'+conversation.id+'/operations/'+operationId);}
 cancelConversation(conversation,runId){return this.request(conversation,'/agents/galaxy-conversation-'+conversation.domain+'/runs/'+runId+'/cancel?'+new URLSearchParams({session_id:conversation.sessionId}),{form:{}});}
 async conversationStreamRequest(conversation,path,form,{signal=null,idempotencyKey=null}={}){
  if(!this.configured())fail('operations_agentos_not_configured');
  const headers={authorization:'Bearer '+this.token(conversation),'content-type':'application/x-www-form-urlencoded',accept:'text/event-stream'};
  if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
  let response;try{response=await this.fetchImpl(this.url+path,{method:'POST',headers,body:new URLSearchParams(form).toString(),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});}catch{fail('operations_agentos_result_unknown');}
  if(!response.ok)fail(response.status===403?'operations_agentos_authority_changed':'operations_agentos_request_failed',response.status===403?403:503);
  if(!response.headers.get('content-type')?.startsWith('text/event-stream'))fail('operations_agentos_response_invalid');
  return response;
 }
 async *conversationEvents(conversation,runId,{after=-1,signal=null}={}){
  const form={session_id:conversation.sessionId,...(after>=0?{last_event_index:String(after)}:{})};
  const response=await this.conversationStreamRequest(conversation,'/agents/galaxy-conversation-'+conversation.domain+'/runs/'+runId+'/resume',form,{signal});
  let cursor=after;
  for await(const frame of nativeSseFrames(response.body)){
   const value=conversationStreamEvent(frame,{runId,after:cursor});if(!value)continue;
   if(value.eventIndex!==null)cursor=value.eventIndex;
   yield value;
   if(['terminal','resync'].includes(value.kind))return;
  }
 }
 async metadata(path){if(!this.configured()||typeof this.serviceKey!=='string'||this.serviceKey.length<32)fail('operations_agentos_not_configured');
  let response;try{response=await this.fetchImpl(this.url+path,{headers:{authorization:'Bearer '+this.serviceKey},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail('operations_agentos_unavailable');}
  if(!response.ok)fail(response.status===404?'operations_agentos_run_not_found':'operations_agentos_unavailable',response.status===404?404:503);
  const body=await response.text();if(body.length>4*1024*1024)fail('operations_agentos_response_invalid');try{return JSON.parse(body);}catch{fail('operations_agentos_response_invalid');}
 }
 runs(query){return this.metadata('/galaxy/runs?'+new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)])).toString());}
 runDetail(id){return this.metadata('/galaxy/runs/'+id);}
 run(execution,{runId,message,review=false}){const component=review?'workflows/galaxy-prepared-review':'agents/galaxy-'+execution.domain;
  return this.request(execution,'/'+component+'/runs',{idempotencyKey:runId,form:{message,stream:'false',background:'true',session_id:execution.sessionId+(review?':review':'')}});}
 async continue(execution,{runId,confirmed}){
  const current=await this.read(execution),run=current.runs.find(item=>item.runId===runId);
  if(!run?.awaitingHuman)fail('operations_agentos_run_not_paused',409);
  // Requirements are read from the native store by a narrow server endpoint,
  // not accepted as arbitrary browser approval/function result JSON.
  return this.request(execution,'/galaxy/executions/'+execution.id+'/continue',{form:{run_id:runId,confirmed:String(confirmed)}});
 }
}
