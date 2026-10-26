import {randomUUID} from "node:crypto";
import {transaction} from "../../database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {p14RuleKeys,p14EmptyControls,p14Parse as parse} from "../../shared/p14-rules-schema.mjs";
import {iso} from './views.mjs';
import {p14PolicySchemas} from './policies.mjs';

// Current rule authority, transaction locks and persisted policy/version facts.
export class P14RulesBase{
 constructor({db,endpoint,businessAdmin,legacyRules,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,businessAdmin,legacyRules,now});}
 metadata(){const checkedAt=this.now();return {checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};}
 async lock(db,key){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.endpoint+':p14-rules:'+key]);}
 async published(db,key){return (await db.query('SELECT * FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key=$2 ORDER BY version DESC LIMIT 1',[this.endpoint,key])).rows[0]??null;}
 async head(db,key){const row=(await db.query('SELECT * FROM operations_p14_rule_heads_v1 WHERE endpoint=$1 AND policy_key=$2',[this.endpoint,key])).rows[0];if(!row)throw new ServiceError('operations_policy_not_initialized',503);return row;}
 async version(db,key,id){return (await db.query('SELECT * FROM operations_p14_rule_versions_v1 WHERE endpoint=$1 AND policy_key=$2 AND id=$3',[this.endpoint,key,id])).rows[0]??null;}
 async addVersion(db,key,policy,{actor=null,source='business-operator',restoredFrom=null,publishedVersion=null,createdAt=iso(this.now()*1000)}={}){
  const version=Number((await db.query('SELECT coalesce(max(version),0)+1 AS version FROM operations_p14_rule_versions_v1 WHERE endpoint=$1 AND policy_key=$2',[this.endpoint,key])).rows[0].version);
  return (await db.query(`INSERT INTO operations_p14_rule_versions_v1(id,endpoint,policy_key,version,policy,source,created_by,created_at,restored_from,published_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),this.endpoint,key,version,JSON.stringify(policy),source,actor?.operatorId??null,createdAt,restoredFrom,publishedVersion])).rows[0];
 }
 // Seed only the currently configured/live three policies. Empty custom rules
 // add no filtering and no new thresholds. A restart never rewrites a head.
 async initialize(){return transaction(this.db,async db=>{
  for(const key of p14RuleKeys){await this.lock(db,key);
   if((await db.query('SELECT 1 FROM operations_p14_rule_heads_v1 WHERE endpoint=$1 AND policy_key=$2',[this.endpoint,key])).rows.length)continue;
   if(key==='business-controls')await db.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at)
    VALUES($1,$2,1,$3,'configured-baseline',$4) ON CONFLICT DO NOTHING`,[this.endpoint,key,JSON.stringify(p14EmptyControls),iso(this.now()*1000)]);
   const previous=(await db.query('SELECT * FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key=$2 ORDER BY version',[this.endpoint,key])).rows;
   if(!previous.length)throw new ServiceError('operations_policy_not_initialized',503);let active;
   for(const current of previous){const policy=parse(p14PolicySchemas[key],current.policy);active=await this.addVersion(db,key,policy,{source:current.source,actor:current.created_by?{operatorId:current.created_by}:null,publishedVersion:current.version,createdAt:iso(current.created_at)});}
   await db.query('INSERT INTO operations_p14_rule_heads_v1(endpoint,policy_key,revision,active_id,updated_at) VALUES($1,$2,0,$3,$4)',[this.endpoint,key,active.id,iso(this.now()*1000)]);
  }
 });}
 async readable(operator){return this.businessAdmin.authorizeAction(operator,'rules.read');}
 async currentActor(operator,authorize,db){
  if(typeof authorize!=='function')throw new ServiceError('operations_authorization_unavailable',503);
  const fresh=await authorize({db});if(!fresh||fresh.kind!=='business-operator'||fresh.operatorId!==operator.operatorId||fresh.endpoint!==this.endpoint)throw new ServiceError('business_admin_denied',403);
  return this.businessAdmin.authorizeAction(fresh,'rules.write',{db});
 }
 async validateAccounts(db,key,policy){if(key!=='business-controls')return;const ids=[...new Set(policy.rules.flatMap(rule=>rule.exceptions.flatMap(exception=>exception.accountIds)))];if(!ids.length)return;
  const count=Number((await db.query('SELECT count(*) AS count FROM community_accounts WHERE endpoint=$1 AND id=ANY($2::uuid[])',[this.endpoint,ids])).rows[0].count);if(count!==ids.length)throw new ServiceError('operations_rule_exception_account_unavailable',409);
 }
}
