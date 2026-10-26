import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {p14Evaluate} from '../rules/evaluator.mjs';
import {p14EmptyControls} from '../../shared/p14-rules-schema.mjs';

// The strategy layer prepares no new domain command. It consumes the one
// already frozen by OperationsAgentOsAuthority and executes through the same
// gateway, preserving the original operation receipt and actor attribution.
export class P13StrategyEffects{
 constructor({authority,gateway,content}){Object.assign(this,{authority,gateway,content,db:authority.db,endpoint:authority.endpoint,now:authority.now});}
 async inspect(executionId,options={}){
  return transaction(this.db,db=>this.inspectWithin(db,executionId,options));
 }
 async inspectWithin(db,executionId,{ownerId=null,conditions=[]}={}){
   const {row}=await this.authority.currentWithin(db,executionId),command=row.prepared_command;
   if(ownerId&&row.created_by!==ownerId)throw new ServiceError('p13_execution_not_found',404);
   if(!command)throw new ServiceError('operations_agentos_prepared_command_required',409);
   const actor=await this.authority.actor(executionId,{db,resourceIds:[command.targetId]}),action=command.input.kind==='hide'?'content.hide':'content.restore';
   await this.authority.requireAction(actor,action,{db});await this.authority.requireAction(actor,'content.read',{db});
   const view=await this.content.viewWithin(db,actor,command.targetKind,command.targetId,{detail:conditions.length>0,lock:true});
   // Count the currently qualified source references, not scanned/visible
   // attachment metadata (which may be absent when its runtime is disabled).
   let attachmentCount;
   if(conditions.some(s=>s.condition)&&view.sourceState==='available'){
    const raw=await this.content.rawWithin(db,command.targetKind,command.targetId),read=await this.content.publicSourceWithin(db,command.targetKind,raw.head,raw.source);
    if(read.available)attachmentCount=(read.payload.attachments??[]).length;
   }
   const conditionResults={};
   for(const s of conditions){if(!s.condition){conditionResults[s.id]={state:'not-applicable',trace:null};continue;}
    const result=p14Evaluate({...p14EmptyControls,rules:[{id:s.id,name:'策略固定条件',enabled:true,targets:[command.targetKind==='post'?'forum-post':'forum-reply'],conditions:s.condition,action:'reject',exceptions:[]}]},
     {target:command.targetKind==='post'?'forum-post':'forum-reply',...(view.sourceState==='available'?{text:view.body,links:view.links,...(attachmentCount===undefined?{}:{attachmentCount})}:{})});
    conditionResults[s.id]={state:result.rules[0]?.state??'unknown',trace:result.rules[0]?.conditions??null};
   }
   let independent=true;
   try{await this.gateway.checkPriorDecision(db,actor,command);}catch(e){if(e.code!=='operations_agentos_human_review_required')throw e;independent=false;}
   const temporalAllowed=command.input.kind==='restore'||Number.isSafeInteger(this.content.maxHideSeconds)&&command.input.until>this.now()&&command.input.until<=this.now()+this.content.maxHideSeconds;
   const can=command.input.kind==='hide'?view.capabilities.canHide:view.capabilities.canRestore;
   return {executionId,ownerId:row.created_by,domain:row.domain,action,target:{kind:command.targetKind,id:command.targetId},
    sourceVersion:view.version,decisionRevision:view.visibility.version,commandSourceVersion:command.input.expectedVersion,commandDecisionRevision:command.input.expectedRevision,
    grantId:row.grant_id,grantVersion:row.grant_version,executorKind:row.executor_kind,grantMode:row.mode,
    conditionResults,facts:{authorized:true,sourceAvailable:view.sourceState==='available'&&can===true,casMatches:view.version===command.input.expectedVersion&&view.visibility.version===command.input.expectedRevision,temporalAllowed,independent}};
 }
 execute(binding){return this.gateway.execute({executionId:binding.execution_id,tool:'execute-prepared-command',arguments:{},runId:binding.id,callId:'p13-prepared-effect'});}
 async priorEffect(binding){return (await this.db.query("SELECT state,operation_id FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND run_id=$3 AND call_id='p13-prepared-effect'",[this.endpoint,binding.execution_id,binding.id])).rows[0]??null;}
 async describe(executionId){return transaction(this.db,async db=>{const {row}=await this.authority.currentWithin(db,executionId),command=row.prepared_command,actor=await this.authority.actor(executionId,{db,resourceIds:[command.targetId]});
  const item=await this.content.viewWithin(db,actor,command.targetKind,command.targetId,{detail:true});
  return {title:item.kind==='post'&&item.sourceState==='available'?item.title:null,createdAt:new Date(row.created_at).toISOString(),sourceExpiresAt:item.publishedUntil??null,commandUntil:command.input.until??null,readExpiresAt:Math.min(this.now()+30,item.publishedUntil??this.now())};
 });}
 async readForAnalysis(binding){return this.gateway.execute({executionId:binding.execution_id,tool:'read-selected-content',arguments:{kind:binding.target_kind,id:binding.target_id},runId:binding.id,callId:'p13-selected-source'});}
}
