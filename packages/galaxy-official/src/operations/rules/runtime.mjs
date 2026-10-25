import {randomUUID} from 'node:crypto';
import {ServiceError} from '../../shared/service-error.mjs';
import {p14ControlsSchema,p14Targets,p14Parse} from '../../shared/p14-rules-schema.mjs';
import {p14Evaluate} from './evaluator.mjs';

// Invoked inside the existing authorized business transaction, after source /
// room checks and before the new write or external send. It never grants any
// right or reads a historical message. Content is transient predicate input.
export class P14RulesRuntime{
 constructor({db,endpoint,accounts,publicWrites,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,accounts,publicWrites,now});this.cache=new Map();}
 async evaluatePublishedWithin(db,version,facts){
  if(!Number.isSafeInteger(version)||version<1||version>2147483647)throw new ServiceError('invalid_operations_rule_request',400);
  const row=(await db.query("SELECT policy FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key='business-controls' AND version=$2",[this.endpoint,version])).rows[0];
  if(!row)throw new ServiceError('operations_rule_version_unavailable',404);
  // A pinned judgment is an explanation of that published rule, never an
  // action grant or permission to skip the current live write gate.
  return {version,evaluation:p14Evaluate(p14Parse(p14ControlsSchema,row.policy),facts)};
 }
 async currentWithin(db){
  // Publishing holds the corresponding exclusive lock. A new operation and a
  // publication therefore have a real transaction order, not a stale UI flag.
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[this.endpoint+':operations-rule:business-controls']);
  const row=(await db.query("SELECT version,policy FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key='business-controls' ORDER BY version DESC LIMIT 1",[this.endpoint])).rows[0];
  if(!row)throw new ServiceError('operations_rules_unavailable',503);
  let policy=this.cache.get(row.version);if(!policy){policy=p14Parse(p14ControlsSchema,row.policy);this.cache.clear();this.cache.set(row.version,policy);}
  return {policy,version:row.version};
 }
 async enforceWithin(db,{actor,account=null,target,operationRef,stage='write',text,links,attachmentCount,fileBytes}){
  if(!p14Targets.includes(target))throw new ServiceError('invalid_operations_rule_target',400);
  const current=await this.currentWithin(db),owner=account??await this.accounts.resolveWithin(db,actor),profile=(await db.query('SELECT subject_type FROM official_account_profiles_v1 WHERE account_id=$1',[owner.id])).rows[0];
  const facts={target,accountId:owner.id,accountTier:await this.publicWrites.tierWithin(db,owner,this.now()),subjectType:profile?.subject_type??undefined,
   ...(typeof text==='string'?{text}:{}),...(links!==undefined?{links}:{}),...(attachmentCount!==undefined?{attachmentCount}:{}),...(fileBytes!==undefined?{fileBytes}:{})};
  const result=p14Evaluate(current.policy,facts);
  if(result.outcome!=='allow')throw Object.assign(new ServiceError(!result.feature.enabled?'operations_feature_disabled':result.outcome==='unknown'?'operations_rule_facts_unavailable':'operations_rule_rejected',result.outcome==='unknown'?503:409),
   {ruleVersion:current.version,ruleIds:result.matchedRuleIds});
  if(operationRef&&['write','upload-bytes'].includes(stage))await db.query(`INSERT INTO operations_p14_rule_decisions_v1(id,endpoint,target,operation_ref,stage,policy_version,matched_rule_ids,exception_ids,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(endpoint,target,operation_ref,stage) DO NOTHING`,[randomUUID(),this.endpoint,target,operationRef,stage,current.version,result.matchedRuleIds,result.exceptionIds,new Date(this.now()*1000).toISOString()]);
  return {version:current.version,outcome:result.outcome,exceptionIds:result.exceptionIds};
 }
}
