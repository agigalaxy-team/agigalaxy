import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {transaction} from "../../infrastructure/database.mjs";
import {p13ConfigurationSchema,p13DraftSchema,p13PublishSchema,p13RehearsalSchema,p13ControlSchema,p13Parse as parse} from "../../shared/p13-strategies-schema.mjs";
import {p13Classify} from "./evaluator.mjs";
import {fail,iso,actionFor} from './views.mjs';
import {P13StrategiesRuntime} from './runtime.mjs';
import {previewStrategyWithin} from './execution-preview.mjs';

// Versioned draft, rehearsal, publication and daily pause/resume commands.
export class P13StrategiesService extends P13StrategiesRuntime{
 previewStrategyWithin(db,input){return previewStrategyWithin(this,db,input);}
 async command(operator,kind,x,operation,{authorize}={}){
  await this.actor(operator,actionFor(kind),{authorize,fresh:true});
  return transaction(this.db,async db=>{
   await this.lock(db);await this.lock(db,'operation:'+x.operationId);const actor=await this.actor(operator,actionFor(kind),{db,authorize,fresh:true});
   const old=(await db.query('SELECT * FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.kind!==kind||!isDeepStrictEqual(old.input,x))fail('p13_operation_conflict');return {...old.result,replayed:true};}
   const head=await this.head(db);if(head.revision!==x.expectedRevision)fail('p13_strategy_revision_changed');
   const result=await operation(db,actor,head);await this.actor(operator,actionFor(kind),{db,authorize,fresh:true});
   await this.businessAdmin.recordWithin(db,actor,actionFor(kind),{operationId:x.operationId,selection:{versionId:result.versionId??head.active_id,revision:head.revision},result:{version:result.version??null,revision:result.revision}});
   await db.query('INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.endpoint,x.operationId,actor.operatorId,kind,JSON.stringify(x),JSON.stringify(result),iso(this.now()*1000)]);
   return {...result,replayed:false};
  });
 }
 saveDraft(operator,input,options){const x=parse(p13DraftSchema,input);return this.command(operator,'draft',x,async(db,actor,head)=>{
  const version=Number((await db.query('SELECT coalesce(max(version),0)+1 AS next FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1',[this.endpoint])).rows[0].next),id=randomUUID(),at=iso(this.now()*1000);
  await db.query('INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,this.endpoint,version,JSON.stringify(x.configuration),actor.operatorId,at]);
  await db.query(`INSERT INTO operations_p13_strategy_heads_v1(endpoint,revision,draft_id,updated_at) VALUES($1,1,$2,$3)
   ON CONFLICT(endpoint) DO UPDATE SET revision=operations_p13_strategy_heads_v1.revision+1,draft_id=EXCLUDED.draft_id,updated_at=EXCLUDED.updated_at`,[this.endpoint,id,at]);
  await this.event(db,'draft',{versionId:id,actor,operationId:x.operationId,metadata:{version}});
  return {operationId:x.operationId,versionId:id,version,revision:head.revision+1,state:'saved'};
 },options);}
 async rehearsal(operator,input){const x=parse(p13RehearsalSchema,input),actor=await this.actor(operator,'strategies.read'),v=await this.version(this.db,x.versionId);if(!v)fail('p13_version_not_found',404);
  const configuration=parse(p13ConfigurationSchema,v.configuration),samples=[];
  for(const executionId of x.executionIds){const facts=await this.effects.inspect(executionId,{ownerId:actor.operatorId,conditions:configuration.strategies});
   for(const strategy of configuration.strategies.filter(s=>s.domain===facts.domain&&s.enabled&&s.template==='selected-public-content-visibility'))samples.push({strategyId:strategy.id,executionId,facts,classification:p13Classify(configuration,strategy,{...facts.facts,conditionState:facts.conditionResults[strategy.id]?.state})});
  }
  const executable=configuration.strategies.filter(s=>s.enabled&&s.template==='selected-public-content-visibility');
  const previews=[];
  await transaction(this.db,async db=>{for(const strategy of configuration.strategies.filter(s=>s.enabled&&s.execution))previews.push({strategyId:strategy.id,...await this.previewStrategyWithin(db,{configuration,strategyId:strategy.id,actor})});});
  const uncovered=[...new Set([...executable.filter(s=>!s.execution&&!samples.some(v=>v.strategyId===s.id&&v.classification.route!=='blocked')).map(s=>s.id),...previews.filter(p=>!p.valid).map(p=>p.strategyId)])];
  const result={versionId:v.id,classification:'program-consumer-qualification',sideEffects:false,modelCalls:0,samples,executionPreviews:previews,uncoveredStrategyIds:uncovered,valid:uncovered.length===0};
  await this.actor(operator,'strategies.read');
  return transaction(this.db,async db=>{await this.lock(db,'rehearsal:'+x.operationId);const old=(await db.query('SELECT * FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.version_id!==v.id||!isDeepStrictEqual(old.execution_ids,x.executionIds))fail('p13_operation_conflict');return {...old.result,rehearsalId:old.id,replayed:true,...this.metadata()};}
   await db.query('INSERT INTO operations_p13_strategy_rehearsals_v1(id,endpoint,version_id,operator_id,execution_ids,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[x.operationId,this.endpoint,v.id,actor.operatorId,x.executionIds,JSON.stringify(result),iso(this.now()*1000)]);
   return {...result,rehearsalId:x.operationId,replayed:false,...this.metadata()};});
 }
 publish(operator,input,options){const x=parse(p13PublishSchema,input);return this.command(operator,'publish',x,async(db,actor,head)=>{
  const version=await this.version(db,x.versionId),sample=(await db.query('SELECT * FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.rehearsalId])).rows[0];
  if(!version||head.draft_id!==version.id||head.blocked_version_ids.includes(version.id))fail('p13_strategy_draft_changed');
  if(!sample||sample.version_id!==version.id||sample.operator_id!==actor.operatorId||!sample.result.valid)fail('p13_rehearsal_required');
  // A program-only rehearsal never pretends to validate semantic judgment.
  const config=parse(p13ConfigurationSchema,version.configuration);
  for(const priorSample of sample.result.samples){const strategy=config.strategies.find(s=>s.id===priorSample.strategyId),current=await this.effects.inspectWithin(db,priorSample.executionId,{ownerId:actor.operatorId,conditions:strategy?[strategy]:[]});
   if(!strategy||p13Classify(config,strategy,{...current.facts,conditionState:current.conditionResults[strategy.id]?.state}).route==='blocked'||current.sourceVersion!==priorSample.facts.sourceVersion||current.decisionRevision!==priorSample.facts.decisionRevision)fail('p13_rehearsal_changed');}
  for(const strategy of config.strategies.filter(s=>s.enabled&&s.execution)){
   const prior=sample.result.executionPreviews?.find(row=>row.strategyId===strategy.id),current=await this.previewStrategyWithin(db,{configuration:config,strategyId:strategy.id,actor});
   if(!prior||!prior.valid||!current.valid||!isDeepStrictEqual(prior,{strategyId:strategy.id,...current}))fail('p13_rehearsal_changed');
  }
  for(const strategy of config.strategies.filter(s=>s.enabled)){
   if((strategy.template==='selected-public-content-visibility'||strategy.execution)&&(!strategy.objective||!config.common.objective||!config.domains.find(d=>d.key===strategy.domain)?.objective))fail('p13_goal_required');
   if(strategy.recovery.versionId){const prior=await this.version(db,strategy.recovery.versionId);if(!prior||prior.id===version.id||head.blocked_version_ids.includes(prior.id)||!prior.configuration.strategies.some(s=>s.id===strategy.id&&s.enabled))fail('p13_recovery_target_unavailable');}
  }
  await db.query('UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,active_id=$2,draft_id=NULL,paused=false,updated_at=$3 WHERE endpoint=$1',[this.endpoint,version.id,iso(this.now()*1000)]);
  await this.event(db,'publish',{versionId:version.id,actor,operationId:x.operationId,metadata:{version:version.version,rehearsalId:x.rehearsalId}});
  return {operationId:x.operationId,versionId:version.id,version:version.version,revision:head.revision+1,state:'active-for-new-matters'};
 },options);}
 control(operator,input,options){const x=parse(p13ControlSchema,input);return this.command(operator,'control',x,async(db,actor,head)=>{
  if(!head.active_id)fail('p13_active_version_required');if(x.kind==='resume'&&head.blocked_version_ids.includes(head.active_id))fail('p13_version_blocked');
  await db.query('UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,paused=$2,updated_at=$3 WHERE endpoint=$1',[this.endpoint,x.kind==='pause',iso(this.now()*1000)]);
  await this.event(db,x.kind,{versionId:head.active_id,actor,operationId:x.operationId});return {operationId:x.operationId,revision:head.revision+1,state:x.kind==='pause'?'paused':'active-for-new-matters'};
 },options);}
}
