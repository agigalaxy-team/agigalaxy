import {transaction} from '../../database.mjs';
import {decisionSchema,parse,fail,iso,terminalStates} from './contract.mjs';
import {operationsAiUsePermission} from '../../shared/operations-ai-use.mjs';

const receiptBases=new Set(['persisted-domain-operation-receipt','original-operation-query','persisted-ai-role-delegation-event']);

/** Native receives outcomes of original operations only. A resume click or a
 * model's report cannot turn an unrecorded effect into a resolved requirement. */
export async function taskContinuationWithin(service,db,row){
 const calls=(await db.query(`SELECT c.call_id,c.operation_id,r.state,r.basis,d.decision
  FROM operations_autonomy_tool_calls_v1 c
  LEFT JOIN operations_autonomy_receipts_v1 r ON r.endpoint=c.endpoint AND r.task_id=c.task_id AND r.operation_id=c.operation_id
  LEFT JOIN operations_autonomy_decisions_v1 d ON d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id AND d.operation_id=c.operation_id
  WHERE c.endpoint=$1 AND c.task_id=$2 AND c.state='waiting-human' ORDER BY c.created_at,c.call_id`,[service.endpoint,row.id])).rows;
 const decisions=[];
 for(const call of calls){
  if(['completed','failed','no-action'].includes(call.state)&&receiptBases.has(call.basis))decisions.push({callId:call.call_id,operationId:call.operation_id,state:call.state,basis:call.basis});
  else if(call.decision)decisions.push({callId:call.call_id,operationId:call.operation_id,state:call.decision,basis:'persisted-human-decision'});
 }
 return{allowed:row.source!=='workbench'&&!!row.native_run_id&&!['stopped','failed','blocked'].includes(row.state)&&row.human_decision?.kind!=='takeover'&&calls.length>0&&decisions.length===calls.length,decisions};
}

export async function recordTaskDecision(service,operator,id,input,{authorize}={}){
 const x=parse(decisionSchema,input);await service.actor(operator,'autonomy.control',{authorize});
 return transaction(service.db,async db=>{
  const actor=await service.actor(operator,'autonomy.control',{db,authorize}),prior=await service.previousWithin(db,actor,x.operationId,'decision',{id,...x});if(prior)return prior;
  const reference=await service.taskWithin(db,id);await service.configWithin(db,reference.domain,{share:true});
  const row=await service.taskWithin(db,id,{lock:true});await service.checkTarget(actor,row,{db});
  if(row.revision!==x.expectedRevision)fail('operations_autonomy_revision_changed');
  if(row.state!=='waiting-human'||row.source==='workbench'||row.human_decision?.kind==='takeover')fail('operations_autonomy_decision_not_pending');
  const call=(await db.query("SELECT * FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3 AND state='waiting-human' FOR UPDATE",[service.endpoint,id,x.callId])).rows[0];
  if(!call)fail('operations_autonomy_decision_not_pending');
  // A receipt whose outcome is unknown may still arrive. A human decision
  // closes the request for further work; it never claims that effect failed.
  await db.query(`INSERT INTO operations_autonomy_decisions_v1(endpoint,task_id,call_id,operation_id,decision_operation_id,operator_id,decision,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(endpoint,task_id,call_id) DO NOTHING`,[service.endpoint,id,x.callId,call.operation_id,x.operationId,actor.operatorId,x.decision,service.at()]);
  const recorded=(await db.query('SELECT * FROM operations_autonomy_decisions_v1 WHERE endpoint=$1 AND task_id=$2 AND call_id=$3',[service.endpoint,id,x.callId])).rows[0];
  if(recorded.decision_operation_id!==x.operationId)fail('operations_autonomy_decision_already_recorded');
  const saved=(await db.query("UPDATE operations_autonomy_tasks_v1 SET human_decision=$3,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 RETURNING *",[service.endpoint,id,JSON.stringify({kind:'resolved',operatorId:actor.operatorId,operationId:call.operation_id,decision:x.decision,at:iso(service.at())}),service.at()])).rows[0];
  return service.recordWithin(db,actor,x.operationId,'decision',{id,...x},{operationId:x.operationId,task:await service.taskView(db,saved,actor),replayed:false});
 });
}

/** The conversation service has already checked the current human/AI role
 * intersection. This binding only narrows it to one owned, existing task. */
export async function bindWorkbenchTaskWithin(service,db,{taskId,operatorId,conversationId,sessionId,domain,aiAccountId,turnOperationId,dryRun=false}){
 const reference=await service.taskWithin(db,taskId);const config=await service.configWithin(db,reference.domain,{share:true});
 const row=await service.taskWithin(db,taskId,{lock:true}),takeover=row.source!=='workbench'&&row.human_decision?.kind==='takeover'&&row.human_decision.operatorId===operatorId,binding=row.configuration.externalWorkbench??{operatorId:takeover?operatorId:null};
 if(row.domain!==domain||row.ai_account_id!==aiAccountId||binding.operatorId!==operatorId||terminalStates.has(row.state)||(row.source==='workbench'?(row.mode!=='human-ai'||row.human_decision?.kind==='takeover'):!takeover||!config.enabled))fail('operations_autonomy_scope_denied',403);
 if(binding.conversationId&&binding.conversationId!==conversationId||binding.sessionId&&binding.sessionId!==sessionId)fail('operations_autonomy_scope_denied',403);
 const pinned=row.configuration.versionBindings?.strategyVersionId;
 if(takeover){for(const frozen of row.configuration.versionBindings?.grants??[]){const grant=(await db.query('SELECT version,enabled FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[service.endpoint,frozen.id])).rows[0];if(!grant?.enabled||grant.version!==frozen.version)fail('operations_autonomy_authorization_changed',403);}}
 if(row.configuration.plan.strategyIds.length){
  const head=(await db.query('SELECT * FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1 FOR SHARE',[service.endpoint])).rows[0];
  if(!head?.active_id||head.paused||head.blocked_version_ids.includes(pinned))fail('operations_autonomy_strategy_stopped');
  const current=(await db.query('SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2',[service.endpoint,head.active_id])).rows[0]?.configuration;
  if(row.configuration.plan.strategyIds.some(id=>!current?.strategies.some(s=>s.id===id&&s.enabled)))fail('operations_autonomy_strategy_stopped');
 }
 const scope=row.configuration.strategyExecution?.resourceScope;
 if(scope?.kind==='unresolved'||scope?.kind==='selected'&&!scope.resourceIds.length)fail('operations_autonomy_strategy_not_ready');
 const configuration={...row.configuration,externalWorkbench:{...binding,conversationId,sessionId,turnOperationId}},newTurn=binding.turnOperationId!==turnOperationId;
 if(newTurn&&!dryRun){
  await db.query("UPDATE operations_autonomy_tasks_v1 SET configuration=$3,state=CASE WHEN source='workbench' THEN 'running' ELSE state END,human_decision=CASE WHEN source='workbench' THEN NULL ELSE human_decision END,primary_model_usage=CASE WHEN source<>'workbench' THEN COALESCE(primary_model_usage,model_usage) ELSE primary_model_usage END,code=NULL,dispatch_started_at=COALESCE(dispatch_started_at,$4),revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2",[service.endpoint,taskId,JSON.stringify(configuration),service.at()]);
  await db.query("INSERT INTO operations_autonomy_workbench_runs_v1(endpoint,task_id,turn_operation_id,model_state,state,created_at,updated_at) VALUES($1,$2,$3,'not-started','running',$4,$4) ON CONFLICT(endpoint,task_id,turn_operation_id) DO NOTHING",[service.endpoint,taskId,turnOperationId,service.at()]);
 }
 return{taskId,goal:configuration.goal,purpose:configuration.purpose,planVersion:row.plan_version,promptVersion:row.prompt_version,strategyIds:configuration.plan.strategyIds,targetType:row.target_type,targetId:row.target_id,resourceScope:scope??null,resourceIds:configuration.plan.resourceIds,actions:configuration.plan.actions};
}

export async function workbenchHrefWithin(service,db,row,actor){
 try{
  await service.businessAdmin.authorizeAction(actor,'autonomy.control',{db});await service.businessAdmin.authorizeAction(actor,operationsAiUsePermission(row.domain),{db});
  const account=await service.aiWorkAccounts.authorizationWithin(db,row.domain,{accountId:row.ai_account_id});if(!account.enabled)return null;
  const binding=row.configuration.externalWorkbench;
  await bindWorkbenchTaskWithin(service,db,{taskId:row.id,operatorId:actor.operatorId,domain:row.domain,aiAccountId:row.ai_account_id,conversationId:binding?.conversationId??null,sessionId:binding?.sessionId??null,turnOperationId:binding?.turnOperationId??row.id,dryRun:true});
  return'/admin?taskId='+row.id;
 }catch(error){if([400,403,404,409,410,503].includes(error.status))return null;throw error;}
}
