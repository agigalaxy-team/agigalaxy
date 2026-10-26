import {randomUUID} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {businessAuditActorContext} from "../audit/attribution.mjs";
import {delegatedAiPromptReadSchema,delegatedAiPromptSaveSchema} from './ai-delegation-schema.mjs';
import {fail,parse} from './helpers.mjs';

const metadata=(account,row)=>({aiAccountId:account.id,domain:account.domain,name:account.name,configId:row.id,revision:row.revision,promptVersion:row.prompt_version,updatedAt:new Date(row.updated_at).toISOString()});

// This is one editable field of the existing versioned configuration. It is
// not a model/credential, strategy, goal, boundary or runtime configuration API.
export class OperationsAiWorkPrompts{
 constructor(owner){this.owner=owner;this.delegation=owner.aiRoleDelegation;this.db=owner.db;this.endpoint=owner.endpoint;}
 async targetWithin(db,current,aiAccountId,{lock=false}={}){
  if(aiAccountId===current.sourceAiAccountId||!current.row.target_ai_account_ids.includes(aiAccountId))fail('operations_ai_delegation_target_denied');
  const account=await this.delegation.account(db,aiAccountId),row=(await db.query('SELECT * FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND domain=$2'+(lock?' FOR UPDATE':''),[this.endpoint,account.domain])).rows[0];
  if(!row)fail('operations_autonomy_config_not_found',404);return{account,row};
 }
 async read(actor,input){const x=parse(delegatedAiPromptReadSchema,input);return transaction(this.db,async db=>{
  const current=await this.delegation.actorWithin(db,actor,'prompt-read'),{account,row}=await this.targetWithin(db,current,x.aiAccountId),context=businessAuditActorContext(this.owner.aiServiceAuthority,current.actor),at=new Date(this.owner.now()*1000).toISOString();
  await this.delegation.actorWithin(db,actor,'prompt-read',{expectedDelegationVersion:current.row.version});
  await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,selection,result,created_at,actor_kind,actor_context)
   VALUES($1,$2,$3,$4,'ai-prompt-read',$5,$6,$7,$8,$9)`,[randomUUID(),this.endpoint,current.actor.operatorId,current.actor.role??null,
   JSON.stringify({delegationId:current.row.id,delegationVersion:current.row.version,sourceAiAccountId:current.sourceAiAccountId,aiAccountId:account.id}),JSON.stringify({revision:row.revision,promptVersion:row.prompt_version}),at,current.actor.kind,context?JSON.stringify(context):null]);
  return{prompt:{...metadata(account,row),text:row.configuration.prompt??''},delegationVersion:current.row.version,scope:'role-work-requirements',instructionAuthority:'role-work-requirements-with-fixed-code-boundaries',checkedAt:this.owner.now(),readExpiresAt:this.owner.now()+30};
 });}
 async save(actor,input,{expectedDelegationVersion=null}={}){const x=parse(delegatedAiPromptSaveSchema,input);return transaction(this.db,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))',[this.endpoint]);
  const current=await this.delegation.actorWithin(db,actor,'prompt-update',{expectedDelegationVersion});actor=current.actor;
  const prior=await this.delegation.replay(db,actor,x.operationId,'prompt-save',x);if(prior)return prior;
  const {account,row:old}=await this.targetWithin(db,current,x.aiAccountId,{lock:true});
  if(old.revision!==x.expectedRevision||old.prompt_version!==x.expectedPromptVersion)fail('operations_ai_prompt_version_changed',409);
  if((old.configuration.prompt??'')===x.prompt)fail('operations_ai_prompt_no_change',409);
  const at=new Date(this.owner.now()*1000),human=actor.kind==='business-operator',configuration={...old.configuration,prompt:x.prompt},
   row=(await db.query(`UPDATE operations_autonomy_configs_v1 SET configuration=$3,revision=revision+1,prompt_version=prompt_version+1,updated_by=$4,updated_by_ai_account_id=$5,updated_at=$6
    WHERE endpoint=$1 AND id=$2 AND revision=$7 AND prompt_version=$8 RETURNING *`,[this.endpoint,old.id,JSON.stringify(configuration),human?actor.operatorId:null,human?null:current.sourceAiAccountId,at,x.expectedRevision,x.expectedPromptVersion])).rows[0];
  if(!row)fail('operations_ai_prompt_version_changed',409);
  await db.query(`INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,delegation_version,operator_id,created_at,managed_by_ai_account_id,management_operation_id,management_delegation_id,management_delegation_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[row.id,row.revision,JSON.stringify(row.configuration),row.prompt_version,row.plan_version,row.delegation_version,human?actor.operatorId:null,at,human?null:current.sourceAiAccountId,x.operationId,current.row.id,current.row.version]);
  await this.delegation.actorWithin(db,actor,'prompt-update',{expectedDelegationVersion:current.row.version});
  return this.delegation.record(db,actor,current.row,x.operationId,'prompt-save',x,{prompt:metadata(account,row)});
 });}
}
