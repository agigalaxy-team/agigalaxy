import {z} from 'zod';
import {ServiceError} from "../../shared/service-error.mjs";
import {p13NativeRunMetadataSchema} from "../../shared/p13-native-run-metadata.mjs";

const domains=['overview','governance','messaging','discovery','maintenance'];
const states=['PENDING','RUNNING','COMPLETED','PAUSED','CANCELLED','ERROR','REGENERATED'];
const spanKinds=['AGENT','CHAIN','LLM','TOOL','RETRIEVER','EMBEDDING','RERANKER','GUARDRAIL','EVALUATOR'];
const querySchema=z.strictObject({page:z.number().int().min(1).max(100000).default(1),limit:z.number().int().min(1).max(100).default(30),domain:z.enum(domains).optional(),state:z.enum(states).optional()});
const fail=(code,status=400)=>{throw new ServiceError(code,status);};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;
const uuid=value=>z.uuid().safeParse(value).success?value:null;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const time=value=>typeof value==='number'?number(value):typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const label=value=>typeof value==='string'&&value.trim()?value.trim().slice(0,200):null;
const tokens=value=>({input:number(value?.input),output:number(value?.output),total:number(value?.total)});
const modelSettingsVersion=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)?value:null;
const modelSettingsVersions=value=>Array.isArray(value)&&value.length>0&&value.every(item=>modelSettingsVersion(item)!==null)?[...value]:null;
function runMetadata(value){
 const runId=id(value?.runId);if(!runId)fail('operations_agentos_response_invalid',503);
 return {runId,executionId:uuid(value.executionId),conversationId:uuid(value.conversationId),sessionId:id(value.sessionId),componentId:id(value.componentId),componentType:['agent','team','workflow'].includes(value.componentType)?value.componentType:null,
  domain:domains.includes(value.domain)?value.domain:null,state:states.includes(value.state)?value.state:null,errorCode:value.state==='ERROR'&&['operations_agentos_run_failed','operations_authorization_unavailable','operations_agentos_authority_changed'].includes(value.errorCode)?value.errorCode:null,createdAt:time(value.createdAt),updatedAt:time(value.updatedAt),
  promptVersion:['galaxy-operations-v1','galaxy-prepared-review-v1','galaxy-conversation-v1','galaxy-conversation-v2','galaxy-p13-selected-content-v1'].includes(value.promptVersion)?value.promptVersion:null,
  rolePromptVersion:Number.isSafeInteger(value.rolePromptVersion)&&value.rolePromptVersion>0?value.rolePromptVersion:null,
  boundaryVersion:value.boundaryVersion==='galaxy-conversation-boundary-v3'?value.boundaryVersion:null,
  modelSettingsVersion:modelSettingsVersion(value.modelSettingsVersion),modelSettingsVersions:modelSettingsVersions(value.modelSettingsVersions),
  tokens:tokens(value.tokens),durationMs:number(value.durationMs),retryCount:null,retryState:'not-recorded',metadataOnly:true,executor:null,conversation:null};
}
function spanMetadata(value){
 const spanId=id(value?.spanId),traceId=id(value?.traceId);if(!spanId||!traceId)return null;
 return {spanId,traceId,parentSpanId:id(value.parentSpanId),name:typeof value.name==='string'&&/^[A-Za-z0-9_. -]{1,100}$/.test(value.name)?value.name:'agno.operation',
  kind:spanKinds.includes(value.kind)?value.kind:null,state:['OK','ERROR','UNSET'].includes(value.state)?value.state:null,startTime:time(value.startTime),endTime:time(value.endTime),durationMs:number(value.durationMs),tokens:tokens(value.tokens),
  input:{state:'not-recorded',value:null},output:{state:'not-recorded',value:null}};
}

/** Global audit metadata. Dialogue prose remains on the separate owner-only route. */
export class OperationsAiRunsService{
 constructor({authority,client}){Object.assign(this,{authority,client,db:authority.db,endpoint:authority.endpoint,now:authority.now});}
 async bind(run){
  if(run.conversationId){
   const row=(await this.db.query(`SELECT c.id,c.domain,c.session_id,p.display_name FROM operations_agentos_conversations_v1 c
    LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=c.operator_id AND p.endpoint=c.endpoint
    WHERE c.endpoint=$1 AND c.id=$2`,[this.endpoint,run.conversationId])).rows[0];
   if(row&&row.domain===run.domain&&row.session_id===run.sessionId)run.conversation={id:row.id,operatorDisplayName:label(row.display_name)};
   // A native reference cannot grant access to a foreign endpoint's identity.
   if(!run.conversation)run.conversationId=null;
  }
  if(!run.conversation||run.componentId!=='galaxy-conversation-'+run.domain){run.rolePromptVersion=null;run.boundaryVersion=null;}
  if(run.executionId){
   const row=(await this.db.query(`SELECT e.executor_kind,e.mode,e.operator_id,e.grant_id,p.display_name FROM operations_agentos_executions_v1 e
    LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=e.operator_id AND p.endpoint=e.endpoint
    WHERE e.endpoint=$1 AND e.id=$2`,[this.endpoint,run.executionId])).rows[0];
   if(row)run.executor={kind:row.executor_kind,mode:row.mode,onBehalfOf:row.operator_id,onBehalfOfDisplayName:label(row.display_name),grantId:row.grant_id};
  }
  return run;
 }
 lease(){const checkedAt=this.now();return {checkedAt,readExpiresAt:checkedAt+30};}
 async runs(operator,input={}){
  const query=querySchema.safeParse(input);if(!query.success)fail('invalid_operations_agentos_request');
  await this.authority.human(operator,{action:'audit.read'});
  const value=await this.client.runs(query.data);if(!Array.isArray(value?.items)||!Number.isSafeInteger(value.total)||value.total<0)fail('operations_agentos_response_invalid',503);
  const items=await Promise.all(value.items.map(item=>this.bind(runMetadata(item))));
  await this.authority.human(operator,{action:'audit.read'});
  return {items,total:value.total,page:query.data.page,nextPage:Number.isSafeInteger(value.nextPage)&&value.nextPage>query.data.page&&value.nextPage<=100000?value.nextPage:null,metadataOnly:true,scope:'all-runtime-run-metadata',...this.lease()};
 }
 async runDetail(operator,runId){
  if(!id(runId))fail('invalid_operations_agentos_request');
  await this.authority.human(operator,{action:'audit.read'});const value=await this.client.runDetail(runId);
  if(value?.run?.runId!==runId)fail('operations_agentos_response_invalid',503);
  const run=await this.bind(runMetadata(value.run)),spans=(Array.isArray(value.spans)?value.spans:[]).map(spanMetadata).filter(Boolean),events=[];
  for(const event of Array.isArray(value.events)?value.events:[]){
   if(typeof event.event==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(event.event)&&!event.event.includes('Reasoning'))events.push({event:event.event,eventIndex:Number.isSafeInteger(event.eventIndex)&&event.eventIndex>=0?event.eventIndex:null,createdAt:time(event.createdAt)});
  }
  const nativeWorkflow=p13NativeRunMetadataSchema.safeParse(value.strategyWorkflow);
  const workflow=run.componentType==='workflow'&&run.componentId==='galaxy-p13-selected-content-v1'&&nativeWorkflow.success&&nativeWorkflow.data.runId===runId?nativeWorkflow.data:null;
  await this.authority.human(operator,{action:'audit.read'});
  return {run,spans,events,workflow,traceCount:Number.isSafeInteger(value.traceCount)&&value.traceCount>=0?value.traceCount:null,input:{state:'withheld',value:null},output:{state:'withheld',value:null},metadataOnly:true,...this.lease()};
 }
}
