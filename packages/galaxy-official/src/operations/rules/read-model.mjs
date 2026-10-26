import {transaction} from "../../database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {hasOperationsPermission} from "../../operations-permission-catalog.mjs";
import {p14RuleKeys,p14KeySchema,p14PageSchema,p14PublishSchema,p14Parse as parse} from "../../shared/p14-rules-schema.mjs";
import {p14RulesCatalog} from "./catalog.mjs";
import {iso,versionView} from './views.mjs';
import {P14RulesBase} from './base.mjs';

// Controlled rule details, adoption state, version history and original command receipts.
export class P14RulesReadModel extends P14RulesBase{
 async detailWithin(db,key,actor){
  const head=await this.head(db,key),active=await this.version(db,key,head.active_id),draft=head.draft_id?await this.version(db,key,head.draft_id):null;
  const records=key==='business-controls'?[]:(await db.query('SELECT * FROM operations_policy_processes_v1 WHERE endpoint=$1 AND policy_key=$2 ORDER BY component,checked_at DESC,instance_id LIMIT 100',[this.endpoint,key])).rows;
  const decisions=key==='business-controls'?(await db.query(`SELECT target,policy_version,count(*)::integer AS count,max(created_at) AS last_applied_at
   FROM operations_p14_rule_decisions_v1 WHERE endpoint=$1 GROUP BY target,policy_version ORDER BY last_applied_at DESC LIMIT 30`,[this.endpoint])).rows:[];
  return {key,revision:head.revision,active:versionView(active),draft:versionView(draft),capabilities:{canEdit:hasOperationsPermission(actor,'rules.write'),canPublish:hasOperationsPermission(actor,'rules.write'),canRestore:hasOperationsPermission(actor,'rules.write'),canTest:true},
   processes:records.map(row=>({component:row.component,instanceId:row.instance_id,adoptedVersion:row.adopted_version,attemptedVersion:row.attempted_version,errorCode:row.error_code,checkedAt:iso(row.checked_at),
    fresh:this.now()-Date.parse(row.checked_at)/1000<=120,current:row.adopted_version===active.published_version&&!row.error_code&&this.now()-Date.parse(row.checked_at)/1000<=120})),
   adoption:{mode:key==='business-controls'?'current-transaction':'process-refresh',publishedVersion:active.published_version,
    observed:decisions.map(row=>({target:row.target,publishedVersion:row.policy_version,count:row.count,lastAppliedAt:iso(row.last_applied_at)}))},catalog:p14RulesCatalog,...this.metadata()};
 }
 async overview(operator){const actor=await this.readable(operator),items=[];for(const key of p14RuleKeys){const item=await this.detailWithin(this.db,key,actor);items.push({key,revision:item.revision,active:item.active,draft:item.draft,capabilities:item.capabilities,adoption:item.adoption});}await this.readable(operator);return {items,catalog:p14RulesCatalog,...this.metadata()};}
 async get(operator,key){parse(p14KeySchema,key);const actor=await this.readable(operator),result=await transaction(this.db,db=>this.detailWithin(db,key,actor));await this.readable(operator);return result;}
 async versions(operator,key,input={}){parse(p14KeySchema,key);await this.readable(operator);const q=parse(p14PageSchema,input);
  if(q.after&&BigInt(q.after)>2147483647n)throw new ServiceError('invalid_operations_rule_request',400);
  const rows=(await this.db.query(`SELECT v.*,e.id AS event_id,e.kind,e.operator_id,e.reason,e.changes
  FROM operations_p14_rule_versions_v1 v LEFT JOIN operations_p14_rule_events_v1 e ON e.version_id=v.id
  WHERE v.endpoint=$1 AND v.policy_key=$2 AND ($3::integer IS NULL OR v.version<$3) ORDER BY v.version DESC LIMIT $4`,[this.endpoint,key,q.after??null,q.limit+1])).rows;
  const baseline=(await this.db.query('SELECT * FROM operations_p14_rule_versions_v1 WHERE endpoint=$1 AND policy_key=$2 AND source=\'configured-baseline\' ORDER BY version LIMIT 1',[this.endpoint,key])).rows[0]??null;
  await this.readable(operator);return {items:rows.slice(0,q.limit).map(row=>({id:row.event_id??row.id,sequence:String(row.version),kind:row.kind??(row.source==='configured-baseline'?'configured-baseline':'legacy-published'),operatorId:row.operator_id??row.created_by??null,reason:row.reason??null,changes:row.changes??{},createdAt:iso(row.created_at),version:versionView(row)})),baseline:versionView(baseline),nextAfter:rows.length>q.limit?String(rows[q.limit-1].version):null,...this.metadata()};
 }
 async operation(operator,id){const actor=await this.readable(operator),row=(await this.db.query('SELECT operator_id,result FROM operations_p14_rule_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,parse(p14PublishSchema.shape.operationId,id)])).rows[0];
  if(!row)return {state:'not-recorded',operationId:id,...this.metadata()};if(row.operator_id!==actor.operatorId)throw new ServiceError('not_found',404);await this.readable(operator);return {state:'recorded',...row.result,...this.metadata()};
 }
}
