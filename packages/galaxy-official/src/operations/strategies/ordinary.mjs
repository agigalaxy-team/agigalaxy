import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {p13OrdinaryDraftSchema,p13OrdinaryPublishSchema,p13ConfigurationSchema,p13Parse} from '../../shared/p13-strategies-schema.mjs';
import {p13Classify} from './evaluator.mjs';

const fail=(code,status=409)=>{throw new ServiceError(code,status);};
const stamp=v=>new Date(v*1000).toISOString();
function leaf(tree,path){let current=tree;for(const index of path){if(!current?.rules||!current.rules[index])return null;current=current.rules[index];}return current&&!current.rules?current:null;}
export function p13OrdinaryChanges(configuration,input){
 const config=structuredClone(configuration),strategy=config.strategies.find(v=>v.id===input.strategyId),bounds=strategy?.ordinaryBounds;
 if(!strategy||!bounds||!['selected-public-content-visibility','business-action','analysis-only'].includes(strategy.template)||strategy.mode==='human-led')fail('p13_ordinary_boundary_requires_human');
 const seen=new Set();
 for(const edit of input.parameterEdits){const key=edit.path.join('.');if(seen.has(key))fail('invalid_p13_strategy_request',400);seen.add(key);
  const bound=bounds.parameters.find(v=>isDeepStrictEqual(v.path,edit.path)),node=leaf(strategy.condition,edit.path);
  if(!bound||!node||typeof node.value!=='number'||edit.value<bound.minimum||edit.value>bound.maximum)fail('p13_ordinary_parameter_requires_human');
  node.value=edit.value;
 }
 if(input.mode!==undefined){if(!bounds.modes.includes(input.mode)||input.mode==='human-led')fail('p13_ordinary_mode_requires_human');strategy.mode=input.mode;if(strategy.execution)strategy.execution.mode={'code-automatic':'code','ai-autonomous':'ai','ai-human-participation':'ai-human'}[input.mode];}
 if(input.enabled!==undefined){if(input.enabled?!bounds.canEnable:!bounds.canDisable)fail('p13_ordinary_enable_requires_human');strategy.enabled=input.enabled;}
 return p13Parse(p13ConfigurationSchema,config);
}

// Only the atomic ordinary commands are available to an attested executor.
// The executor cannot supply a whole configuration, goals, condition structure,
// instruction prose, template, recovery approval or the numeric authorization
// bounds themselves. Ordinary disabling/enabling applies to new matters.
export class P13OrdinaryStrategies{
 constructor({strategies}){Object.assign(this,{strategies,db:strategies.db,endpoint:strategies.endpoint,authority:strategies.authority,now:strategies.now});}
 async actor(identity,strategyId,action,db=this.db,input=null){
  if(this.authority.acceptsDuty?.(identity))return action==='strategies.read'?this.authority.requireDutyAction(identity,action,{db}):this.authority.requireDutyOperation(identity,[action],{id:strategyId,...input},{db,action});
  if(identity?.kind==='business-operator')return this.strategies.businessAdmin.authorizeAction(identity,action,{db});
  const actor=await this.authority.actor(identity,{db,resourceIds:[strategyId]});return this.authority.requireAction(actor,action,{db});
 }
 async inspectWithin(db,identity,strategyId){
  const actor=await this.actor(identity,strategyId,'strategies.read',db),head=await this.strategies.head(db),version=await this.strategies.version(db,head.active_id),strategy=version?.configuration.strategies.find(s=>s.id===strategyId);
  if(!strategy)fail('p13_strategy_not_found',404);return{actor,head,version,strategy};
 }
 async read(identity,strategyId){return transaction(this.db,async db=>{
  const {head,version,strategy}=await this.inspectWithin(db,identity,strategyId),draft=await this.strategies.version(db,head.draft_id);await this.actor(identity,strategyId,'strategies.read',db);
  return {revision:head.revision,versionId:version.id,strategy,draft:draft?{id:draft.id,version:draft.version,strategyId:draft.ordinary_strategy_id,createdBy:draft.created_by,executionId:draft.ordinary_execution_id,taskId:draft.ordinary_task_id??null,aiAccountId:draft.ordinary_ai_account_id??null}:null,goals:{common:version.configuration.common.objective,domain:version.configuration.domains.find(d=>d.key===strategy.domain)?.objective??null},...this.strategies.metadata()};
 });
 }
 async prepare(identity,kind,input){return transaction(this.db,async db=>{
  const {actor,head,version,strategy}=await this.inspectWithin(db,identity,input.strategyId);if(head.paused||!head.active_id||!strategy.ordinaryBounds||strategy.mode==='human-led')fail('p13_ordinary_boundary_requires_human');
  let command;
  if(kind==='draft'){
   if(head.draft_id)fail('p13_existing_draft_requires_human');p13OrdinaryChanges(version.configuration,input);
   command={expectedRevision:head.revision,strategyId:strategy.id,parameterEdits:input.parameterEdits??[],...(input.mode===undefined?{}:{mode:input.mode}),...(input.enabled===undefined?{}:{enabled:input.enabled})};
  }else if(kind==='publish'){
   const candidate=await this.strategies.version(db,input.versionId),duty=this.authority.acceptsDuty?.(actor)===true,sameIdentity=candidate&&(duty?candidate.ordinary_task_id===actor.taskId&&candidate.ordinary_ai_account_id===actor.aiAccountId:actor.kind==='operations-executor'?candidate.ordinary_execution_id===actor.executionId:candidate.created_by===actor.operatorId&&!candidate.ordinary_task_id&&!candidate.ordinary_execution_id);
   if(!sameIdentity||head.draft_id!==candidate.id||candidate.ordinary_strategy_id!==strategy.id||candidate.parent_id!==version.id||head.blocked_version_ids.includes(candidate.id))fail('p13_ordinary_draft_changed');
   command={expectedRevision:head.revision,strategyId:strategy.id,versionId:candidate.id};
  }else fail('invalid_p13_strategy_request',400);
  await this.actor(identity,strategy.id,'strategies.read',db);return{command,strategy:{id:strategy.id,name:strategy.name,domain:strategy.domain},...this.strategies.metadata()};
 });}
 async operation(identity,strategyId,operationId){return transaction(this.db,async db=>{
  const actor=await this.actor(identity,strategyId,'strategies.read',db),row=(await db.query('SELECT operator_id,kind,input,result FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
  if(!row)return{state:'not-recorded',operationId,...this.strategies.metadata()};if(row.operator_id!==actor.operatorId||row.result.strategyId!==strategyId)fail('p13_operation_not_found',404);
  await this.actor(identity,strategyId,'strategies.read',db);return{state:'recorded',operationId,kind:row.kind,input:row.input,result:{...row.result,replayed:true},...this.strategies.metadata()};
 });}
 async command(identity,kind,input){if(!['draft','publish'].includes(kind))fail('invalid_p13_strategy_request',400);const x=p13Parse(kind==='draft'?p13OrdinaryDraftSchema:p13OrdinaryPublishSchema,input),action='strategies.ordinary.'+(kind==='draft'?'configure':'publish');
  return transaction(this.db,async db=>{
   await this.strategies.lock(db);await this.strategies.lock(db,'operation:'+x.operationId);const actor=await this.actor(identity,x.strategyId,action,db,x),duty=this.authority.acceptsDuty?.(actor)===true,executionId=actor.kind==='operations-executor'?actor.executionId:null;
   const old=(await db.query('SELECT * FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.kind!=='ordinary-'+kind||!isDeepStrictEqual(old.input,x))fail('p13_operation_conflict');return {...old.result,replayed:true};}
   const head=await this.strategies.head(db);if(head.revision!==x.expectedRevision)fail('p13_strategy_revision_changed');if(head.paused||!head.active_id)fail('p13_strategy_paused');
   const current=await this.strategies.version(db,head.active_id),prior=current.configuration.strategies.find(s=>s.id===x.strategyId);
   if(!prior||!prior.ordinaryBounds||prior.mode==='human-led')fail('p13_ordinary_boundary_requires_human');
   let id,version,configuration,changes;
   if(kind==='draft'){
    if(head.draft_id)fail('p13_existing_draft_requires_human');
    configuration=p13OrdinaryChanges(current.configuration,x);id=randomUUID();version=Number((await db.query('SELECT coalesce(max(version),0)+1 AS next FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1',[this.endpoint])).rows[0].next);
    await db.query(`INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at,parent_id,ordinary_strategy_id,ordinary_execution_id,ordinary_task_id,ordinary_ai_account_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,this.endpoint,version,JSON.stringify(configuration),actor.operatorId,stamp(this.now()),current.id,x.strategyId,executionId,duty?actor.taskId:null,duty?actor.aiAccountId:null]);
    changes={parameters:x.parameterEdits.map(e=>({path:e.path,before:leaf(prior.condition,e.path)?.value??null,after:e.value})),...(x.enabled===undefined?{}:{enabled:{before:prior.enabled,after:x.enabled}}),...(x.mode===undefined?{}:{mode:{before:prior.mode,after:x.mode}})};
    await db.query('UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,draft_id=$2,updated_at=$3 WHERE endpoint=$1',[this.endpoint,id,stamp(this.now())]);
   }else{
    const candidate=await this.strategies.version(db,x.versionId);
    const sameIdentity=candidate&&(duty?candidate.ordinary_task_id===actor.taskId&&candidate.ordinary_ai_account_id===actor.aiAccountId:executionId?candidate.ordinary_execution_id===executionId:candidate.created_by===actor.operatorId&&!candidate.ordinary_task_id&&!candidate.ordinary_execution_id);
    if(!candidate||!sameIdentity||head.draft_id!==candidate.id||candidate.ordinary_strategy_id!==x.strategyId||candidate.parent_id!==current.id||head.blocked_version_ids.includes(candidate.id))fail('p13_ordinary_draft_changed');
    // Reconstruct through the same allowed-field adapter, not a trust in the
    // stored full JSON. This proves the goals/boundaries remain byte-equivalent.
    const draftCommand=(await db.query("SELECT input FROM operations_p13_strategy_commands_v1 WHERE endpoint=$1 AND operator_id=$2 AND kind='ordinary-draft' AND result->>'versionId'=$3",[this.endpoint,actor.operatorId,candidate.id])).rows[0];
    if(!draftCommand||!isDeepStrictEqual(p13OrdinaryChanges(current.configuration,draftCommand.input),candidate.configuration))fail('p13_ordinary_boundary_requires_human');
    configuration=p13Parse(p13ConfigurationSchema,candidate.configuration);const selected=configuration.strategies.find(s=>s.id===x.strategyId),samples=[];let preview=null;
    // The human's published rehearsal contains explicit concrete execution
    // references. No sample means no automatic publication of an enabled plan.
    if(selected.enabled&&selected.template!=='selected-public-content-visibility'){
     if(typeof this.strategies.previewStrategyWithin!=='function')fail('p13_rehearsal_required');
     preview=await this.strategies.previewStrategyWithin(db,{configuration,strategyId:selected.id,actor});if(preview?.valid!==true||preview.sideEffects!==false||preview.modelCalls!==0)fail('p13_rehearsal_required');samples.push(...(preview.samples??[]));
    }else if(selected.enabled){let sampleVersion=current,executionIds=[],depth=0;
     // Daily disable has no side-effect sample itself. Re-enabling may reuse
     // only the explicit sample references of its immutable ordinary ancestry,
     // never discover new objects or interpret an empty list as "all".
     while(sampleVersion&&depth++<200){const rehearsal=(await db.query('SELECT execution_ids FROM operations_p13_strategy_rehearsals_v1 WHERE endpoint=$1 AND version_id=$2 AND (result->>\'valid\')::boolean ORDER BY created_at DESC LIMIT 1',[this.endpoint,sampleVersion.id])).rows[0];
      if(rehearsal?.execution_ids.length){executionIds=rehearsal.execution_ids;break;}
      if(!sampleVersion.ordinary_execution_id&&!sampleVersion.ordinary_task_id)break;sampleVersion=await this.strategies.version(db,sampleVersion.parent_id);
     }
     for(const taskId of executionIds){try{const facts=await this.strategies.effects.inspectWithin(db,taskId,{conditions:[selected]});if(facts.domain!==selected.domain)continue;
      const classification=p13Classify(configuration,selected,{...facts.facts,conditionState:facts.conditionResults[selected.id]?.state});if(classification.route!=='blocked')samples.push({strategyId:selected.id,executionId:taskId,facts,classification});
     }catch(error){if(!(error instanceof ServiceError))throw error;}}
     if(!samples.length)fail('p13_rehearsal_required');
    }
    id=candidate.id;version=candidate.version;
    const rehearsalId=randomUUID();await db.query('INSERT INTO operations_p13_strategy_rehearsals_v1(id,endpoint,version_id,operator_id,execution_ids,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[rehearsalId,this.endpoint,id,actor.operatorId,samples.map(s=>s.executionId).filter(Boolean),JSON.stringify({valid:true,sideEffects:false,modelCalls:0,classification:selected.enabled?'bounded-ordinary-consumer':'stop-new-matters',samples,uncoveredStrategyIds:[],...(preview?{preview}:{})}),stamp(this.now())]);
    await db.query('UPDATE operations_p13_strategy_heads_v1 SET revision=revision+1,active_id=$2,draft_id=NULL,updated_at=$3 WHERE endpoint=$1',[this.endpoint,id,stamp(this.now())]);
    changes={rehearsalId,parentVersionId:current.id};
   }
   await this.actor(identity,x.strategyId,action,db,x);
   await this.strategies.event(db,kind==='draft'?'ordinary-draft':'publish',{versionId:id,strategyId:x.strategyId,actor,operationId:x.operationId,metadata:{version,scope:'ordinary-strategy',actorKind:actor.kind,aiAccountId:duty?actor.aiAccountId:null,taskId:duty?actor.taskId:null,changes}});
   await this.strategies.businessAdmin.recordWithin(db,actor,action,{operationId:x.operationId,selection:{versionId:id,strategyId:x.strategyId,revision:head.revision},result:{version,revision:head.revision+1}});
   const result={operationId:x.operationId,strategyId:x.strategyId,versionId:id,version,revision:head.revision+1,state:kind==='draft'?'saved':'active-for-new-matters',newMattersOnly:true};
   await db.query('INSERT INTO operations_p13_strategy_commands_v1(endpoint,operation_id,operator_id,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.endpoint,x.operationId,actor.operatorId,'ordinary-'+kind,JSON.stringify(x),JSON.stringify(result),stamp(this.now())]);return {...result,replayed:false};
  });
 }
}
