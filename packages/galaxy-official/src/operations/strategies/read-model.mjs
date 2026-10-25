import {p13EmptyConfiguration,p13PageSchema,p13Parse as parse} from "../../shared/p13-strategies-schema.mjs";
import {p13Catalog} from "./catalog.mjs";
import {z} from "zod";
import {fail,iso,versionView,nativeSummary} from './views.mjs';
import {P13StrategiesBase} from './base.mjs';

// Controlled strategy, execution, version and original receipt reads.
export class P13StrategiesReadModel extends P13StrategiesBase{
 async get(operator){const actor=await this.actor(operator,'strategies.read'),head=await this.head(this.db),active=await this.version(this.db,head.active_id),draft=await this.version(this.db,head.draft_id);
  const status=await this.native.status();await this.actor(operator,'strategies.read');const p=actor.businessAuthorization?.permissions??[];
  return {revision:head.revision,active:versionView(active),draft:versionView(draft),paused:head.paused,blockedVersionIds:head.blocked_version_ids,
   configuration:active?.configuration??p13EmptyConfiguration,catalog:p13Catalog,native:status,
   capabilities:{canConfigure:p.includes('strategies.configure'),canPublish:p.includes('strategies.publish'),canRun:p.includes('strategies.run')&&status.state==='connected',canControl:p.includes('strategies.control'),canAiConfigure:false},...this.metadata()};
 }
 async ownedRun(operator,id,action='strategies.read'){const actor=await this.actor(operator,action),row=(await this.db.query('SELECT * FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id])).rows[0];if(!row||row.operator_id!==actor.operatorId)fail('p13_run_not_found',404);return {actor,row};}
 async options(operator){const actor=await this.actor(operator,'strategies.read'),rows=(await this.db.query("SELECT id,prepared_command FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND created_by=$2 AND state='active' AND prepared_command IS NOT NULL ORDER BY created_at DESC,id LIMIT 100",[this.endpoint,actor.operatorId])).rows,items=[];
  let readExpiresAt=this.now()+30;
  for(const row of rows){const bound=(await this.db.query('SELECT id,state FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2',[this.endpoint,row.id])).rows[0];
   try{const current=await this.effects.inspect(row.id,{ownerId:actor.operatorId}),label=await this.effects.describe(row.id);readExpiresAt=Math.min(readExpiresAt,label.readExpiresAt);items.push({executionId:row.id,domain:current.domain,grantId:current.grantId,grantVersion:current.grantVersion,executorKind:current.executorKind,mode:current.grantMode,target:current.target,title:label.title,createdAt:label.createdAt,sourceExpiresAt:label.sourceExpiresAt,commandUntil:label.commandUntil,action:current.action,sourceVersion:current.sourceVersion,decisionRevision:current.decisionRevision,
    canRehearse:Object.values(current.facts).every(v=>v===true),available:!bound&&Object.values(current.facts).every(v=>v===true),boundRunId:bound?.id??null,code:bound?'already-bound':Object.values(current.facts).every(v=>v===true)?null:'qualification-required'});}
   catch{items.push({executionId:row.id,domain:null,target:null,available:false,boundRunId:bound?.id??null,code:'currently-unavailable'});}
  }
  await this.actor(operator,'strategies.read');return {items,nextAfter:null,basis:{scope:'owned-active-prepared-executions',limit:100,complete:rows.length<100},...this.metadata(),readExpiresAt};
 }
 async runDetail(operator,id){const {row}=await this.ownedRun(operator,id);const native=await this.native.read(row,{history:true});
  const version=await this.version(this.db,row.version_id),strategy=version?.configuration.strategies.find(s=>s.id===row.strategy_id);
  let continuation=await this.continuationCapability(operator,row,native);
  const current=await this.actor(operator,'strategies.read');
  if(continuation.canContinue&&!(current.businessAuthorization?.permissions??[]).includes('strategies.run'))continuation={canContinue:false,continueCode:'permission-denied'};
  return {run:{id:row.id,strategyId:row.strategy_id,versionId:row.version_id,executionId:row.execution_id,strategy:strategy?{id:strategy.id,name:strategy.name,domain:strategy.domain,mode:strategy.mode,judgment:strategy.judgment}:null,version:version?{id:version.id,version:version.version}:null,target:{kind:row.target_kind,id:row.target_id,sourceVersion:row.source_version,decisionRevision:row.decision_revision},decision:row.decision,workflow:{id:row.workflow_id,version:row.workflow_version},ruleRefs:row.rule_refs,route:row.route,state:row.state,code:row.code,
   native:nativeSummary(native),...continuation,canReadNativeRun:(current.businessAuthorization?.permissions??[]).includes('audit.read'),effect:row.effect_result,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)},...this.metadata()};
 }
 async continuationCapability(operator,row,native){
  const no=continueCode=>({canContinue:false,continueCode});
  if(row.effect_result||['completed','no-action','blocked'].includes(row.state))return no('not-waiting');
  if(!native)return no('runtime-unavailable');
  if(native.status!=='PAUSED'||native.awaitingHuman!==true)return no('not-waiting');
  if(native.runId!==row.native_run_id||native.workflowId!==row.workflow_id||native.workflowVersion!==row.workflow_version||!/^[A-Za-z0-9_-]{1,128}:[0-9]{1,6}$/.test(native.pauseId??''))return no('check-unavailable');
  try{
   await this.actor(operator,'strategies.run');
   const head=await this.head(this.db),live=await this.version(this.db,head.active_id);
   if(!live||head.paused||head.blocked_version_ids.includes(row.version_id)||!live.configuration.common.automationEnabled||!live.configuration.domains.some(d=>d.key==='governance'&&d.executionEnabled))return no('strategy-paused');
   const commands=(await this.db.query("SELECT result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND kind='continue' AND input->>'runId'=$2",[this.endpoint,row.id])).rows;
   if(commands.some(c=>!c.result.continuation||c.result.continuation.nativeRunId===native.runId&&c.result.continuation.pauseId===native.pauseId))return no('decision-recorded');
   // This is the same read-only qualification used before continuation. It
   // neither consumes a tool call nor prepares/executes a business command.
   const current=await this.effects.inspect(row.execution_id,{ownerId:row.operator_id});
   if(current.sourceVersion!==row.source_version||current.decisionRevision!==row.decision_revision||Object.values(current.facts).some(v=>v!==true))return no('qualification-changed');
   return {canContinue:true,continueCode:null};
  }catch(error){
   if(['operations_permission_denied','business_admin_denied'].includes(error.code))return no('permission-denied');
   if(['operations_agentos_execution_inactive','operations_agentos_authority_changed','operations_agentos_scope_unresolved','operations_agentos_scope_denied','operations_agentos_action_unavailable','operations_ai_work_disabled','operations_ai_work_unassigned','operations_agentos_ai_use_denied','p13_execution_not_found'].includes(error.code))return no('authorization-changed');
   if(['operations_agentos_source_changed','p13_current_qualification_changed','operations_agentos_prepared_command_required'].includes(error.code))return no('qualification-changed');
   return no('check-unavailable');
  }
 }
 async continuationReceipt(row,command,{history=false}={}){
  const binding=command.result?.continuation,base={operationId:command.operation_id??command.result.operationId,runId:row.id,nativeRunId:binding?.nativeRunId??null,pauseId:binding?.pauseId??null};
  // Historical decisions have no exact native pause binding. Never infer an
  // unaccepted decision from a currently paused run, or silently dispatch it.
  if(!binding||typeof this.native.continuation!=='function')return {...base,state:'unknown'};
  const value=await this.native.continuation(row,base.operationId,{history,expectedPauseId:base.pauseId});
  if(!value||Object.entries(base).some(([key,v])=>value[key]!==v))return {...base,state:'unknown'};
  const state=['accepted','not-recorded'].includes(value.state)?value.state:'unknown';
  if(state==='accepted')await this.settleContinuation(row,command,base);
  return {...base,state};
 }
 async settleContinuation(row,command,binding){
  const result=command.result,approved=result.confirmed===true||result.inputDecision==='proceed',declined=result.confirmed===false||result.inputDecision==='no-action';
  if(!approved&&!declined||row.native_run_id!==binding.nativeRunId)return;
  // This settles only an immutable, already accepted native continuation.
  // GET recovery may settle its local lifecycle, but never dispatches again.
  // A completed effect, a stopped run, or an unresolved effect result wins.
  await this.db.query(`UPDATE operations_p13_strategy_runs_v1
   SET state=$5,decision=CASE WHEN $6 THEN 'no-action' ELSE decision END,updated_at=$7
   WHERE endpoint=$1 AND id=$2 AND operator_id=$3 AND native_run_id=$4
    AND effect_result IS NULL AND state NOT IN ('completed','no-action','blocked')
    AND code IS DISTINCT FROM 'original-effect-reconciliation-required'
    AND (state IS DISTINCT FROM $5 OR ($6 AND decision IS DISTINCT FROM 'no-action'))
    AND (($6 AND approved_by IS NULL AND approval_native_run_id IS NULL)
      OR (NOT $6 AND approved_by=$3 AND approval_native_run_id=$4))`,
   [this.endpoint,row.id,row.operator_id,binding.nativeRunId,declined?'no-action':'running',declined,iso(this.now()*1000)]);
 }
 async records(operator,input={}){await this.actor(operator,'strategies.read');const x=parse(p13PageSchema,input),rows=(await this.db.query('SELECT e.sequence,e.id,e.version_id,e.strategy_id,e.run_id,e.kind,e.operator_id,e.metadata,e.created_at,p.display_name AS operator_display_name FROM operations_p13_strategy_events_v1 e LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=e.endpoint AND p.operator_id=e.operator_id WHERE e.endpoint=$1 AND ($2::bigint IS NULL OR e.sequence<$2) AND ($3::uuid IS NULL OR e.strategy_id=$3) ORDER BY e.sequence DESC LIMIT $4',[this.endpoint,x.after??null,x.strategyId??null,x.limit+1])).rows;
  await this.actor(operator,'strategies.read');return {items:rows.slice(0,x.limit).map(r=>({id:r.id,sequence:String(r.sequence),versionId:r.version_id,strategyId:r.strategy_id,runId:r.run_id,kind:r.kind,operatorId:r.operator_id,operatorDisplayName:r.operator_display_name??null,metadata:r.metadata,createdAt:iso(r.created_at)})),nextAfter:rows.length>x.limit?String(rows[x.limit-1].sequence):null,...this.metadata()};
 }
 async versions(operator,input={}){await this.actor(operator,'strategies.read');const x=parse(p13PageSchema,input),rows=(await this.db.query('SELECT v.*,p.display_name AS created_by_display_name FROM operations_p13_strategy_versions_v1 v LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=v.endpoint AND p.operator_id=v.created_by WHERE v.endpoint=$1 AND ($2::integer IS NULL OR v.version<$2) ORDER BY v.version DESC LIMIT $3',[this.endpoint,x.after?Number(x.after):null,x.limit+1])).rows;
  await this.actor(operator,'strategies.read');return {items:rows.slice(0,x.limit).map(versionView),nextAfter:rows.length>x.limit?String(rows[x.limit-1].version):null,...this.metadata()};
 }
 async operation(operator,id){const actor=await this.actor(operator,'strategies.read'),x=parse(z.uuid(),id),row=(await this.db.query('SELECT operator_id,kind,result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x])).rows[0];
  if(row&&row.operator_id!==actor.operatorId)fail('p13_operation_not_found',404);
  if(row){let continuation;if(row.kind==='continue'){const owned=await this.ownedRun(operator,row.result.runId);continuation=await this.continuationReceipt(owned.row,{...row,operation_id:x},{history:true});}await this.actor(operator,'strategies.read');return {state:'recorded',kind:row.kind,result:row.result,...(continuation?{continuation}:{}),...this.metadata()};}
  const run=(await this.db.query('SELECT operator_id FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x])).rows[0];
  if(run?.operator_id===actor.operatorId)return {state:'recorded',kind:'run',...await this.runDetail(operator,x)};
  await this.actor(operator,'strategies.read');return {state:'not-recorded',operationId:x,...this.metadata()};
 }
}
