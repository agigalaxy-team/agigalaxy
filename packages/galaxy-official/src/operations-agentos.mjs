import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {agentOsRunSchema,agentOsContinueSchema} from './shared/operations-agentos-schema.mjs';
import {isDeepStrictEqual} from 'node:util';
import {AgentOsConversations} from './operations-agentos-conversations.mjs';
import {OperationsAiRunsService} from './operations-ai-runs.mjs';
import {AgentOsConversationTools} from './operations-agentos-conversation-tools.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const parse=(schema,value)=>{const x=schema.safeParse(value);if(!x.success)fail('invalid_operations_agentos_request',400);return x.data;};
export class OperationsAgentOsService {
 constructor({authority,client,summaryForConversation=null}){Object.assign(this,{authority,client,db:authority.db,endpoint:authority.endpoint,now:authority.now});this.conversations=new AgentOsConversations({authority,client,summaryForConversation});this.aiRuns=new OperationsAiRunsService({authority,client});authority.conversations=this.conversations;}
 conversation(operator,domain){return this.conversations.read(operator,domain);}
 conversationRun(operator,domain,input,options){return this.conversations.run(operator,domain,input,options);}
 conversationOperation(operator,domain,id){return this.conversations.operation(operator,domain,id);}
 conversationCancel(operator,domain,id,input,options){return this.conversations.cancel(operator,domain,id,input,options);}
 conversationEvents(operator,domain,id,options){return this.conversations.events(operator,domain,id,options);}
 connectConversationTools({gateway,services}){this.conversations.tools=new AgentOsConversationTools({conversations:this.conversations,authority:this.authority,gateway,services});}
 conversationCard(operator,domain,id){return this.conversations.tools.card(operator,domain,id);}
 conversationConfirm(operator,domain,id,input,options){return this.conversations.tools.confirm(operator,domain,id,input,options);}
 conversationDismiss(operator,domain,id,input,options){return this.conversations.tools.dismiss(operator,domain,id,input,options);}
 runs(operator,input={}){return this.aiRuns.runs(operator,input);}
 runDetail(operator,runId){return this.aiRuns.runDetail(operator,runId);}
 async status(operator){await this.authority.human(operator);return {...await this.client.status(),checkedAt:this.now(),readExpiresAt:this.now()+30};}
 async operation(operator,id){
  const recorded=await this.authority.operation(operator,id),{commandState,...receipt}=recorded;
  if(recorded.state==='not-recorded'||!['run','review','continue'].includes(recorded.kind))return receipt;
  if(commandState==='not-started')return {...receipt,state:'not-started',native:null};
  let run=null;
  try{const current=await this.client.read(recorded.execution);run=current.runs.find(item=>item.runId===recorded.runId||item.operationId===id)??null;}
  catch(error){if(error.status===403)throw error;}
  // This is a pure receipt read. Absence or a transport failure never starts
  // another native run, reviews another command, or replays a human decision.
  await this.authority.operation(operator,id);
  return {...receipt,state:run?.status??commandState??'unknown',native:run};
 }
 async get(operator,id){const meta=await this.authority.get(operator,id);let native=null,runtimeState='unavailable';
  const status=await this.client.status();if(status.state==='connected'&&meta.execution.state!=='stopped'){try{native=await this.client.read(meta.execution);runtimeState='connected';}catch(error){if(error.status===403)throw error;}}
  await this.authority.get(operator,id);return {...meta,native,readExpiresAt:Math.min(meta.readExpiresAt,Number.isFinite(native?.readExpiresAt)?native.readExpiresAt:meta.readExpiresAt),runtimeState:status.state==='not-configured'?'not-configured':runtimeState,modelState:status.modelState};
 }
 async command(operator,id,kind,input,{authorize}={}){if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  if(kind==='run'){const status=await this.client.status();if(status.state!=='connected')fail('operations_agentos_not_configured',503);if(status.modelState!=='configured')fail('operations_agentos_model_not_configured',503);}
  const saved=await transaction(this.db,async db=>{
   await this.authority.human(operator,{db,authorize});const {row,actor}=await this.authority.ownedWithin(db,operator,id);
   await this.authority.currentWithin(db,id);if(kind==='review'&&!row.prepared_command)fail('operations_agentos_prepared_command_required',409);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912421))',[this.endpoint+':'+input.operationId]);
   const old=(await db.query('SELECT * FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,input.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.execution_id!==id||old.kind!==kind||!isDeepStrictEqual(old.input,input))fail('operations_agentos_operation_conflict',409);return {old:old.result,execution:this.authority.view(row)};}
   const receipt={operationId:input.operationId,runId:kind==='continue'?input.runId:null,state:'dispatching',replayed:false};
   await db.query(`INSERT INTO operations_agentos_commands_v1(id,endpoint,execution_id,kind,operator_id,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.operationId,this.endpoint,id,kind,actor.operatorId,JSON.stringify(input),JSON.stringify(receipt),new Date(this.now()*1000).toISOString()]);return {execution:this.authority.view(row),receipt};
  });
  if(saved.old){const current=await this.client.read(saved.execution),run=current.runs.find(item=>item.runId===saved.old.runId||item.operationId===input.operationId);
   await this.authority.get(operator,id);
   return {...saved.old,operationId:input.operationId,kind,executionId:id,state:run?.status??saved.old.state,native:run??null,replayed:true};}
  try{
   // Current session/management identity is checked again before dispatch.
   await this.authority.human(operator,{authorize,domain:saved.execution.executorKind==='ai'?saved.execution.domain:null});await this.authority.actor(id,{active:true});
   const result=kind==='continue'?await this.client.continue(saved.execution,input):await this.client.run(saved.execution,{runId:input.operationId,message:kind==='review'?'执行已准备的操作':input.message,review:kind==='review'});
   const receipt={...saved.receipt,operationId:input.operationId,kind,executionId:id,runId:result.run_id??result.runId??null,state:'accepted',native:{runId:result.run_id??result.runId??null,status:result.status??null}};
   await this.db.query('UPDATE operations_agentos_commands_v1 SET result=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,input.operationId,JSON.stringify(receipt)]);
   await this.authority.human(operator,{authorize,domain:saved.execution.executorKind==='ai'?saved.execution.domain:null});return receipt;
  }catch(error){const receipt={...saved.receipt,state:['operations_agentos_model_not_configured','operations_agentos_authority_changed'].includes(error.code)?'not-started':'unknown'};
   await this.db.query('UPDATE operations_agentos_commands_v1 SET result=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,input.operationId,JSON.stringify(receipt)]);throw error;
  }
 }
 run(operator,id,input,options){return this.command(operator,id,'run',parse(agentOsRunSchema,input),options);}
 review(operator,id,input,options){return this.command(operator,id,'review',parse(agentOsRunSchema,input),options);}
 continue(operator,id,input,options){return this.command(operator,id,'continue',parse(agentOsContinueSchema,input),options);}
}
