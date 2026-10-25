import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {transaction} from "../../database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {p14KeySchema,p14DraftSchema,p14PublishSchema,p14SampleSchema,p14Parse as parse} from "../../shared/p14-rules-schema.mjs";
import {p14Evaluate} from "./evaluator.mjs";
import {p14QuotaCounts} from "./quota.mjs";
import {enforceResourceGrowth} from "../../infrastructure/resource-budgets.mjs";
import {iso,changes} from './views.mjs';
import {p14PolicySchemas} from './policies.mjs';
import {P14RulesReadModel} from './read-model.mjs';

// Versioned draft/publication/restoration commands and deterministic, side-effect-free samples.
export class P14RulesService extends P14RulesReadModel{
 async command(operator,key,kind,input,{authorize}={}){
  parse(p14KeySchema,key);const x=parse(kind==='draft'?p14DraftSchema:p14PublishSchema,input);await this.currentActor(operator,authorize,this.db);
  const receipt=await transaction(this.db,async db=>{
   const actor=await this.currentActor(operator,authorize,db);await this.lock(db,key);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.endpoint+':p14-operation:'+x.operationId]);
   const old=(await db.query('SELECT * FROM operations_p14_rule_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,x.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.policy_key!==key||old.kind!==kind||!isDeepStrictEqual(old.input,x))throw new ServiceError('operations_command_changed',409);return {...old.result,replayed:true};}
   const head=await this.head(db,key),active=await this.version(db,key,head.active_id);if(head.revision!==x.expectedRevision)throw new ServiceError('operations_rule_revision_changed',409);
   let target,policy;
   if(kind==='draft')policy=parse(p14PolicySchemas[key],x.policy);
   else{target=await this.version(db,key,x.versionId);if(!target)throw new ServiceError('operations_rule_version_unavailable',404);
    if(kind==='publish'&&head.draft_id!==target.id)throw new ServiceError('operations_rule_draft_changed',409);
    if(kind==='restore'&&target.published_version===null)throw new ServiceError('operations_rule_version_not_published',409);
    policy=parse(p14PolicySchemas[key],target.policy);
   }
   await this.validateAccounts(db,key,policy);let publishedVersion=null;
   if(kind!=='draft'){
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.endpoint+':operations-rule:'+key]);
    const actual=await this.published(db,key);if(actual.version!==active.published_version)throw new ServiceError('operations_rule_source_changed',409);
    publishedVersion=actual.version+1;
    await db.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,created_by,source,created_at)
     VALUES($1,$2,$3,$4,$5,'business-operator',$6)`,[this.endpoint,key,publishedVersion,JSON.stringify(policy),actor.operatorId,iso(this.now()*1000)]);
   }
   const version=await this.addVersion(db,key,policy,{actor,source:kind==='restore'?'restore':'business-operator',restoredFrom:kind==='restore'?target.id:null,publishedVersion}),at=iso(this.now()*1000);
   await db.query('UPDATE operations_p14_rule_heads_v1 SET revision=revision+1,active_id=$3,draft_id=$4,updated_at=$5 WHERE endpoint=$1 AND policy_key=$2',[this.endpoint,key,kind==='draft'?head.active_id:version.id,kind==='draft'?version.id:null,at]);
   const delta=changes(kind==='draft'?(head.draft_id?(await this.version(db,key,head.draft_id)).policy:active.policy):active.policy,policy);
   await db.query('INSERT INTO operations_p14_rule_events_v1(id,endpoint,policy_key,operation_id,version_id,kind,operator_id,reason,changes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),this.endpoint,key,x.operationId,version.id,kind,actor.operatorId,x.reason,JSON.stringify(delta),at]);
   const result={operationId:x.operationId,kind,key,versionId:version.id,version:version.version,publishedVersion,revision:head.revision+1,recordedAt:at};
   // The generic audit contains no terms, rule names, sample text or reason.
   await this.businessAdmin.recordWithin(db,actor,'rule-save',{operationId:x.operationId,selection:{key,expectedVersion:active.published_version},result:{version:publishedVersion??active.published_version}});
   await db.query('INSERT INTO operations_p14_rule_commands_v1(endpoint,operation_id,operator_id,policy_key,kind,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[this.endpoint,x.operationId,actor.operatorId,key,kind,JSON.stringify(x),JSON.stringify(result),at]);
   await this.currentActor(operator,authorize,db);return {...result,replayed:false};
  });
  return {...receipt,detail:await this.get(operator,key)};
 }
 saveDraft(operator,key,input,options){return this.command(operator,key,'draft',input,options);}
 publish(operator,key,input,options){return this.command(operator,key,'publish',input,options);}
 restore(operator,key,input,options){return this.command(operator,key,'restore',input,options);}
 async sample(operator,key,input){parse(p14KeySchema,key);await this.readable(operator);const x=parse(p14SampleSchema,input);
  const version=x.versionId?await this.version(this.db,key,x.versionId):null;if(x.versionId&&!version)throw new ServiceError('operations_rule_version_unavailable',404);
  const policy=parse(p14PolicySchemas[key],version?.policy??x.policy);
  let evaluation;
  if(key==='business-controls'){if(!x.sample.target)throw new ServiceError('invalid_operations_rule_request',400);evaluation=p14Evaluate(policy,x.sample);}
  else if(key==='resource-budget'){
   if(!x.sample.before||!x.sample.after)evaluation={outcome:'unknown',missingFacts:['before','after'],sideEffects:false};
   else{try{enforceResourceGrowth({...x.sample.before,payloadBytes:BigInt(x.sample.before.payloadBytes)},{...x.sample.after,payloadBytes:BigInt(x.sample.after.payloadBytes)},policy);evaluation={outcome:'allow',sideEffects:false};}
    catch(error){if(!(error instanceof ServiceError))throw error;evaluation={outcome:'reject',code:error.code,sideEffects:false};}}
  }else{
   const categories=key==='forum-quota'?['post','version','reply','report']:['task','comment','invitation'],category=x.sample.quotaCategory,tier=x.sample.accountTier;
   if(!tier||x.sample.used===undefined||!categories.includes(category))evaluation={outcome:'unknown',missingFacts:[...(!tier?['accountTier']:[]),...(x.sample.used===undefined?['used']:[]),...(!categories.includes(category)?['quotaCategory']:[])],sideEffects:false};
   else{const count=p14QuotaCounts(policy[tier][category],x.sample.used);evaluation={outcome:count.remaining?'allow':'reject',quota:{category,tier,...count},sideEffects:false};}
  }
  await this.readable(operator);return {key,versionId:version?.id??null,publishedVersion:version?.published_version??null,evaluation,...this.metadata()};
 }
}
