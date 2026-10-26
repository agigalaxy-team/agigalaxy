import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {transaction} from "../../infrastructure/database.mjs";
import {p13ConfigurationSchema,p13RunSchema,p13ContinueSchema,p13NativeStepSchema,p13Workflow,p13Parse as parse} from "../../shared/p13-strategies-schema.mjs";
import {p13Classify} from "./evaluator.mjs";
import {z} from "zod";
import {fail,iso} from './views.mjs';
import {P13StrategiesReadModel} from './read-model.mjs';

// Pinned run dispatch, original human continuation and native step qualification.
export class P13StrategiesRuntime extends P13StrategiesReadModel{
 async run(operator,input,{authorize}={}){const x=parse(p13RunSchema,input),actor=await this.actor(operator,'strategies.run',{authorize,fresh:true});
  const existing=(await this.db.query('SELECT * FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
  if(existing){if(existing.operator_id!==actor.operatorId||existing.strategy_id!==x.strategyId||existing.execution_id!==x.executionId)fail('p13_operation_conflict');
   if(existing.state==='prepared'&&['model-not-configured','native-not-connected'].includes(existing.code)){
    // Retry only a known, previously unaccepted start after native confirms no
    // durable run exists. A timeout/unknown result is never a new dispatch.
    const recorded=await this.native.read(existing);
    if(recorded?.status==='NOT_RECORDED'){
     await this.nativeContext({runId:existing.id,executionId:existing.execution_id,operation:'run'});
     await this.effects.inspect(existing.execution_id,{ownerId:actor.operatorId});
     await this.actor(operator,'strategies.run',{authorize,fresh:true});
     await this.native.start(existing);
     await this.db.query('UPDATE operations_p13_strategy_runs_v1 SET code=NULL,updated_at=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,existing.id,iso(this.now()*1000)]);
    }
   }
   return this.runDetail(operator,existing.id);}
  // Inspection owns its transaction. Never query the global pool from inside
  // a transaction that already holds that connection/authority lock.
  const plannedHead=await this.head(this.db),plannedVersion=await this.version(this.db,plannedHead.active_id),plannedStrategy=plannedVersion?.configuration.strategies.find(s=>s.id===x.strategyId);if(!plannedStrategy)fail('p13_strategy_not_found',404);
  const facts=await this.effects.inspect(x.executionId,{ownerId:actor.operatorId,conditions:[plannedStrategy]});
  const binding=await transaction(this.db,async db=>{await this.lock(db);await this.lock(db,'execution:'+x.executionId);await this.actor(operator,'strategies.run',{db,authorize,fresh:true});
   const head=await this.head(db),version=await this.version(db,head.active_id);if(head.paused||!version||head.blocked_version_ids.includes(version.id))fail('p13_strategy_paused');
   if(version.id!==plannedVersion.id)fail('p13_strategy_revision_changed');
   const configuration=parse(p13ConfigurationSchema,version.configuration),strategy=configuration.strategies.find(s=>s.id===x.strategyId);if(!strategy)fail('p13_strategy_not_found',404);
   const classified=p13Classify(configuration,strategy,{...facts.facts,conditionState:facts.conditionResults[strategy.id]?.state});if(classified.route==='blocked')fail('p13_qualification_required');
   const old=(await db.query('SELECT id FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2',[this.endpoint,x.executionId])).rows[0];if(old)fail('p13_execution_already_bound');
   const rules=(await db.query("SELECT policy_key,version FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key='business-controls' ORDER BY version DESC LIMIT 1",[this.endpoint])).rows;
   // Visibility is not a new-post/write consumer of P14. Preserve that fact
   // with the reference instead of asserting that P14 authorized this action.
   const ruleRefs=rules.map(r=>({key:r.policy_key,publishedVersion:r.version,scope:'new-writes-only',appliesToPreparedVisibility:false})),at=iso(this.now()*1000);
   const saved=(await db.query(`INSERT INTO operations_p13_strategy_runs_v1(id,endpoint,version_id,strategy_id,execution_id,operator_id,workflow_id,workflow_version,session_id,target_kind,target_id,source_version,decision_revision,rule_refs,route,state,decision,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'prepared',$16,$17,$17) RETURNING *`,[x.operationId,this.endpoint,version.id,strategy.id,x.executionId,actor.operatorId,p13Workflow.id,p13Workflow.version,randomUUID(),facts.target.kind,facts.target.id,facts.sourceVersion,facts.decisionRevision,JSON.stringify(ruleRefs),classified.route,classified.decision??null,at])).rows[0];
   await this.event(db,'matter-pinned',{versionId:version.id,strategyId:strategy.id,runId:saved.id,actor,operationId:x.operationId,metadata:{route:classified.route,workflowVersion:p13Workflow.version}});return saved;
  });
  try{await this.native.start(binding);return this.runDetail(operator,binding.id);}catch(error){const missing=error.code==='operations_agentos_model_not_configured',notConnected=error.code==='p13_native_workflow_not_connected';await this.db.query('UPDATE operations_p13_strategy_runs_v1 SET state=$3,code=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2',[this.endpoint,binding.id,missing||notConnected?'prepared':'unknown',missing?'model-not-configured':notConnected?'native-not-connected':'native-dispatch-unknown',iso(this.now()*1000)]);throw error;}
 }
 async continue(operator,id,input,{authorize}={}){
  const x=parse(p13ContinueSchema,input),{row,actor}=await this.ownedRun(operator,id,'strategies.run');await this.actor(operator,'strategies.run',{authorize,fresh:true});
  const same=old=>{if(old.operator_id!==actor.operatorId||old.kind!=='continue'||!isDeepStrictEqual(old.input,{...x,runId:id}))fail('p13_operation_conflict');return old;};
  // The immutable command is checked BEFORE any native pause/source check.
  // After acceptance the run may already be running, complete or unavailable.
  let command=(await this.db.query('SELECT * FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];
  if(command)same(command);
  else{
   const native=await this.native.read(row);
   if(!native?.awaitingHuman||native.runId!==row.native_run_id)fail('p13_run_not_paused');
   if(!/^[A-Za-z0-9_-]{1,128}:[0-9]{1,6}$/.test(native.pauseId??''))fail('p13_native_continuation_not_ready',503);
   if(native.pauseKind==='input'?x.inputDecision===undefined:x.confirmed===undefined)fail('p13_pause_input_mismatch',400);
   command=await transaction(this.db,async db=>{
    await this.lock(db,'run:'+id);await this.lock(db,'operation:'+x.operationId);await this.actor(operator,'strategies.run',{db,authorize,fresh:true});
    const old=(await db.query('SELECT * FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];if(old)return same(old);
    const current=(await db.query('SELECT * FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,id])).rows[0];
    if(!current||current.operator_id!==actor.operatorId||current.native_run_id!==native.runId||current.effect_result||['completed','no-action','blocked'].includes(current.state))fail('p13_run_not_paused');
    const prior=(await db.query("SELECT result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND kind='continue' AND input->>'runId'=$2",[this.endpoint,id])).rows;
    if(prior.some(v=>!v.result.continuation||v.result.continuation.nativeRunId===native.runId&&v.result.continuation.pauseId===native.pauseId))fail('p13_pause_decision_already_recorded');
    const facts=await this.effects.inspectWithin(db,row.execution_id,{ownerId:actor.operatorId});
    if(facts.sourceVersion!==row.source_version||facts.decisionRevision!==row.decision_revision||Object.values(facts.facts).some(v=>v!==true))fail('p13_current_qualification_changed');
    const approved=x.confirmed===true||x.inputDecision==='proceed',result={operationId:x.operationId,runId:id,...(x.confirmed===undefined?{inputDecision:x.inputDecision}:{confirmed:x.confirmed}),continuation:{nativeRunId:native.runId,pauseId:native.pauseId}};
    await db.query('UPDATE operations_p13_strategy_runs_v1 SET approved_by=$3,approval_native_run_id=$4,decision=coalesce($5,decision),updated_at=$6 WHERE endpoint=$1 AND id=$2',[this.endpoint,id,approved?actor.operatorId:null,approved?native.runId:null,x.inputDecision??null,iso(this.now()*1000)]);
    await db.query('INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,\'continue\',$4,$5,$6)',[this.endpoint,x.operationId,actor.operatorId,JSON.stringify({...x,runId:id}),JSON.stringify(result),iso(this.now()*1000)]);
    return {operation_id:x.operationId,result};
   });
  }
  let receipt=await this.continuationReceipt(row,command);
  if(receipt.state==='not-recorded'){
   // Only a positive native not-recorded receipt can re-submit this exact
   // command. Unknown/accepted receipts never cause a new transition.
   await this.actor(operator,'strategies.run',{authorize,fresh:true});
   const native=await this.native.read(row);
   if(!native?.awaitingHuman||native.runId!==receipt.nativeRunId||native.pauseId!==receipt.pauseId)fail('p13_run_not_paused');
   const facts=await this.effects.inspect(row.execution_id,{ownerId:actor.operatorId});
   if(facts.sourceVersion!==row.source_version||facts.decisionRevision!==row.decision_revision||Object.values(facts.facts).some(v=>v!==true))fail('p13_current_qualification_changed');
   await this.native.continue(row,x);receipt=await this.continuationReceipt(row,command);
  }
  return {...await this.runDetail(operator,id),operationId:x.operationId,continuation:receipt};
 }
 async nativeBinding(input){const x=parse(p13NativeStepSchema,input),row=(await this.db.query('SELECT * FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.runId])).rows[0];
  if(!row||row.execution_id!==x.executionId||row.native_run_id&&row.native_run_id!==x.nativeRunId)fail('p13_native_binding_denied',403);
  // Even a completed receipt may not disclose an old result after revocation.
  await this.authority.actor(row.execution_id);
  const head=await this.head(this.db),version=await this.version(this.db,row.version_id),live=await this.version(this.db,head.active_id);
  if(!version||!live||head.paused||head.blocked_version_ids.includes(version.id))fail('p13_strategy_paused');
  const configuration=parse(p13ConfigurationSchema,version.configuration),strategy=configuration.strategies.find(s=>s.id===row.strategy_id);if(!strategy)fail('p13_strategy_not_found',404);
  const currentBounds=parse(p13ConfigurationSchema,live.configuration);if(!currentBounds.common.automationEnabled||!currentBounds.domains.find(d=>d.key===strategy.domain)?.executionEnabled)fail('p13_strategy_paused');
  return {x,row,head,version,configuration,strategy};
 }
 async nativeContext(input){const x=parse(z.strictObject({runId:z.uuid(),executionId:z.uuid(),operation:z.enum(['read','run']),continuationOperationId:z.uuid().optional()}),input),row=(await this.db.query('SELECT * FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.runId])).rows[0];
  if(!row||row.execution_id!==x.executionId)fail('p13_native_binding_denied',403);await this.authority.actor(row.execution_id,{active:x.operation==='run'});
  if(x.operation==='run')await this.nativeBinding({runId:row.id,executionId:row.execution_id,nativeRunId:row.native_run_id??row.id,phase:'prepare'});
  let continuation;
  if(x.continuationOperationId){const command=(await this.db.query("SELECT operator_id,input,result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2 AND kind='continue'",[this.endpoint,x.continuationOperationId])).rows[0];
   if(!command||command.operator_id!==row.operator_id||command.input.runId!==row.id||!command.result.continuation||command.result.continuation.nativeRunId!==row.native_run_id)fail('p13_native_binding_denied',403);
   continuation={operationId:x.continuationOperationId,runId:row.id,...command.result.continuation,...(command.input.confirmed===undefined?{inputDecision:command.input.inputDecision}:{confirmed:command.input.confirmed})};
  }
  return {runId:row.id,executionId:row.execution_id,sessionId:row.session_id,nativeRunId:row.native_run_id,workflow:p13Workflow,state:row.state,route:row.route,versionId:row.version_id,strategyId:row.strategy_id,...(continuation?{continuation}:{})};
 }
 async step(input){
  const {x,row,configuration,strategy}=await this.nativeBinding(input);
  if(x.phase==='failed')return this.stopBadVersion(row,strategy,x.failure??'workflow-failed');
  if(row.effect_result)return {state:'completed',effect:row.effect_result};
  if(row.decision==='no-action'&&['effect','finished'].includes(x.phase)){
   await this.db.query("UPDATE operations_p13_strategy_runs_v1 SET state='no-action',updated_at=$3 WHERE endpoint=$1 AND id=$2",[this.endpoint,row.id,iso(this.now()*1000)]);return {state:'no-action'};
  }
  const priorEffect=x.phase==='effect'?await this.effects.priorEffect(row):null;
  const facts=priorEffect?null:await this.effects.inspect(row.execution_id,{ownerId:row.operator_id,conditions:[strategy]});
  const classified=facts?p13Classify(configuration,strategy,{...facts.facts,conditionState:facts.conditionResults[strategy.id]?.state}):null;
  if(facts&&(facts.sourceVersion!==row.source_version||facts.decisionRevision!==row.decision_revision||classified.route==='blocked')){
   await this.db.query("UPDATE operations_p13_strategy_runs_v1 SET state='blocked',code='current-qualification-changed',updated_at=$3 WHERE endpoint=$1 AND id=$2",[this.endpoint,row.id,iso(this.now()*1000)]);fail('p13_current_qualification_changed');
  }
  // The native worker has actually entered this bound step. Record the same
  // human-wait lifecycle for fixed human-led routes as for semantic decisions.
  // The UI additionally requires the exact native PAUSED requirement; this
  // database state alone never authorizes a continuation or a business effect.
  await this.db.query(`UPDATE operations_p13_strategy_runs_v1
   SET native_run_id=$3,updated_at=$4,state=CASE
    WHEN $5 AND state NOT IN ('completed','no-action','blocked') AND effect_result IS NULL THEN
     CASE WHEN (route='human' OR decision IN ('human-required','needs-input'))
      AND NOT (approved_by IS NOT NULL AND approval_native_run_id=$3) THEN 'awaiting-human' ELSE 'running' END
    ELSE state END
   WHERE endpoint=$1 AND id=$2 AND (native_run_id IS NULL OR native_run_id=$3)`,[this.endpoint,row.id,x.nativeRunId,iso(this.now()*1000),x.phase==='prepare']);
  if(x.phase==='prepare')return {runId:row.id,strategyId:strategy.id,versionId:row.version_id,workflow:p13Workflow,route:row.route,mode:strategy.mode,judgment:strategy.judgment,instructions:strategy.instructions,
   requiresHuman:row.route==='human'||row.decision==='human-required',requiresInput:row.decision==='needs-input',decision:row.decision,domain:strategy.domain,sourceRef:{kind:row.target_kind,id:row.target_id,version:row.source_version}};
  if(x.phase==='decision'){
   if(!['ai','human'].includes(row.route)||!x.decision)fail('p13_decision_denied',403);
   const decision=row.route==='human'?'human-required':x.decision==='needs-input'&&strategy.mode!=='ai-human-participation'?'human-required':x.decision;
   await this.db.query('UPDATE operations_p13_strategy_runs_v1 SET decision=$3,state=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2',[this.endpoint,row.id,decision,decision==='no-action'?'no-action':['human-required','needs-input'].includes(decision)?'awaiting-human':'running',iso(this.now()*1000)]);
   return {decision,advisory:row.route==='human'?x.decision:null,requiresHuman:decision==='human-required',requiresInput:decision==='needs-input'};
  }
  if(x.phase==='finished'){
   if(row.decision==='no-action'){await this.db.query("UPDATE operations_p13_strategy_runs_v1 SET state='no-action',updated_at=$3 WHERE endpoint=$1 AND id=$2",[this.endpoint,row.id,iso(this.now()*1000)]);return {state:'no-action'};}
   // Native completion cannot manufacture a business effect receipt.
   fail('p13_effect_receipt_required');
  }
  if(row.route==='ai'&&!['proceed','human-required'].includes(row.decision))fail('p13_decision_required');
  if(row.route==='human'||row.decision==='human-required'){
   if(!row.approved_by||row.approval_native_run_id!==x.nativeRunId)fail('p13_human_confirmation_required');
   await this.actor({kind:'business-operator',operatorId:row.approved_by,endpoint:this.endpoint},'strategies.run');
  }
  try{
   const effect=await this.effects.execute(row);
   // Store only the receipt projection, not public prose/reason or arbitrary
   // data returned by a domain service. Its original audit remains authoritative.
   const result={operationId:effect.operationId,kind:effect.kind,id:effect.id,visibility:effect.visibility??null};
   await this.db.query("UPDATE operations_p13_strategy_runs_v1 SET state='completed',effect_result=$3,code=NULL,updated_at=$4 WHERE endpoint=$1 AND id=$2",[this.endpoint,row.id,JSON.stringify(result),iso(this.now()*1000)]);
   await this.event(this.db,'effect-recorded',{versionId:row.version_id,strategyId:row.strategy_id,runId:row.id,metadata:{operationId:result.operationId}});
   return {state:'completed',effect:result};
  }catch(error){await this.db.query("UPDATE operations_p13_strategy_runs_v1 SET state='unknown',code='original-effect-reconciliation-required',updated_at=$3 WHERE endpoint=$1 AND id=$2",[this.endpoint,row.id,iso(this.now()*1000)]);throw error;}
 }
 async stopBadVersion(row,strategy,failure){
  return transaction(this.db,async db=>{await this.lock(db);const head=await this.head(db),blocked=[...new Set([...head.blocked_version_ids,row.version_id])];
   let active=head.active_id,paused=head.paused,recovered=false;
   if(active===row.version_id){paused=true;
    if(strategy.recovery.versionId&&strategy.recovery.conditions.includes(failure)&&!blocked.includes(strategy.recovery.versionId)){
     const prior=await this.version(db,strategy.recovery.versionId),published=(await db.query("SELECT 1 FROM operations_p13_strategy_events_v1 WHERE endpoint=$1 AND version_id=$2 AND kind='publish' LIMIT 1",[this.endpoint,strategy.recovery.versionId])).rows.length>0;
     const target=prior&&parse(p13ConfigurationSchema,prior.configuration);
     if(published&&target?.common.automationEnabled&&target.domains.find(d=>d.key===strategy.domain)?.executionEnabled&&target.strategies.some(s=>s.id===strategy.id&&s.enabled)){
      // Recovery is allowed only under the still-current permission of the
      // human who explicitly approved this target in the failing version.
      let approvedVersion=await this.version(db,row.version_id),depth=0;
      // Ordinary descendants cannot create a human recovery approval. Follow
      // their immutable parent chain to the explicit human-published version.
      while((approvedVersion?.ordinary_execution_id||approvedVersion?.ordinary_task_id)&&depth++<200){const parent=await this.version(db,approvedVersion.parent_id),parentStrategy=parent?.configuration.strategies.find(s=>s.id===strategy.id);
       if(!parentStrategy||!isDeepStrictEqual(parentStrategy.recovery,strategy.recovery)){approvedVersion=null;break;}approvedVersion=parent;}
      const approval=approvedVersion&&!approvedVersion.ordinary_execution_id&&!approvedVersion.ordinary_task_id?(await db.query("SELECT operator_id FROM operations_p13_strategy_events_v1 WHERE endpoint=$1 AND version_id=$2 AND kind='publish' AND metadata->>'scope' IS DISTINCT FROM 'ordinary-strategy' ORDER BY sequence DESC LIMIT 1",[this.endpoint,approvedVersion.id])).rows[0]:null;
      try{if(!approval?.operator_id)fail('p13_recovery_approval_unavailable');await this.actor({kind:'business-operator',operatorId:approval.operator_id,endpoint:this.endpoint},'strategies.publish',{db});active=prior.id;paused=false;recovered=true;}catch{/* Remain paused; no permission fallback. */}
     }
    }
   }
   await db.query('UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,active_id=$2,paused=$3,blocked_version_ids=$4,updated_at=$5 WHERE endpoint=$1',[this.endpoint,active,paused,blocked,iso(this.now()*1000)]);
   await db.query("UPDATE operations_p13_strategy_runs_v1 SET state='blocked',code=$3,updated_at=$4 WHERE endpoint=$1 AND version_id=$2 AND state NOT IN ('completed','no-action')",[this.endpoint,row.version_id,failure,iso(this.now()*1000)]);
   await this.event(db,'automatic-stop',{versionId:row.version_id,strategyId:row.strategy_id,runId:row.id,metadata:{failure,recovered,recoveredVersionId:recovered?active:null,newMattersOnly:true}});
   return {state:'blocked',failure,recovered,recoveredVersionId:recovered?active:null,newMattersOnly:true};
  });
 }
}
