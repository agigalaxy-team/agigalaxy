import {randomUUID} from "node:crypto";
import {fail,iso} from './views.mjs';

// Current operator authority, transaction locks and persistent strategy facts.
export class P13StrategiesBase{
 constructor({db,endpoint,businessAdmin,authority,effects,native,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,businessAdmin,authority,effects,native,now});}
 metadata(){const checkedAt=this.now();return {checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};}
 lock(db,key='head'){return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912437))',[this.endpoint+':p13:'+key]);}
 async actor(operator,action,{db=this.db,authorize=null,fresh=false}={}){
  if(fresh){if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);const current=await authorize({db});if(!current||current.kind!=='business-operator'||current.operatorId!==operator.operatorId||current.endpoint!==this.endpoint)fail('business_admin_denied',403);operator=current;}
  // Common boundaries and domain goals are never editable by an AI actor.
  if(operator?.kind==='operations-ai-service'&&action==='strategies.read')return this.businessAdmin.authorizeAction(operator,action,{db});
  if(operator?.kind!=='business-operator')fail('business_admin_denied',403);
  if(!this.businessAdmin.permissions?.requireAction)fail('operations_authorization_unavailable',503);
  return this.businessAdmin.permissions.requireAction(operator,action,{db});
 }
 async head(db){return (await db.query('SELECT * FROM operations_p13_strategy_heads_v1 WHERE endpoint=$1',[this.endpoint])).rows[0]??{revision:0,active_id:null,draft_id:null,paused:true,blocked_version_ids:[]};}
 async version(db,id){return id?(await db.query('SELECT v.*,p.display_name AS created_by_display_name FROM operations_p13_strategy_versions_v1 v LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=v.endpoint AND p.operator_id=v.created_by WHERE v.endpoint=$1 AND v.id=$2',[this.endpoint,id])).rows[0]??null:null;}
 async event(db,kind,{versionId=null,strategyId=null,runId=null,actor=null,operationId=null,metadata={}}={}){
  await db.query(`INSERT INTO operations_p13_strategy_events_v1(id,endpoint,version_id,strategy_id,run_id,kind,operator_id,operation_id,metadata,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),this.endpoint,versionId,strategyId,runId,kind,actor?.operatorId??null,operationId,JSON.stringify(metadata),iso(this.now()*1000)]);
 }
}
