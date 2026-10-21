import {isDeepStrictEqual} from 'node:util';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';

export const operationsStamp=value=>new Date(value*1000).toISOString();
export const operationsIso=value=>value?new Date(value).toISOString():null;
export const operationsFail=(code,status=409)=>{throw new ServiceError(code,status);};
export function operationsParse(schema,input){const value=schema.safeParse(input);if(!value.success)operationsFail('invalid_operations_request',400);return value.data;}

// Operations restrictions supplement current source permission. They never
// replace it, change an author revision, or grant an operator owner authority.
export async function operationsVisibilityWithin(db,{endpoint,kind,id,now}){
 const row=(await db.query('SELECT * FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3',[endpoint,kind,id])).rows[0];
 return {version:row?.revision??0,hidden:!!row?.hidden_until&&Date.parse(row.hidden_until)>now*1000,until:operationsIso(row?.hidden_until),operationId:row?.operation_id??null};
}
export class OperationsBusinessDomain {
 constructor({businessAdmin,now=businessAdmin.now}){this.businessAdmin=businessAdmin;this.db=businessAdmin.db;this.endpoint=businessAdmin.endpoint;this.now=now;}
 require(operator,write=false){return this.businessAdmin.require(operator,{write});}
 async principalWithin(db,actor){
  const principal=(await db.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2 FOR SHARE',[actor.operatorId,this.endpoint])).rows[0];
  if(!principal)operationsFail('business_admin_denied',403);return principal;
 }
 async run(operator,write,action,selection,fn){const actor=this.require(operator,write);if(selection.id)selection={...selection,resourceId:selection.id};return transaction(this.db,async db=>{
  await this.principalWithin(db,actor);
  const result=await fn(db,actor);await this.businessAdmin.recordWithin(db,actor,action,{selection,result:{count:result.items?.length??null}});return result;
 });}
 async command(operator,action,selection,fn){const actor=this.require(operator,true);if(selection.id)selection={...selection,resourceId:selection.id};return transaction(this.db,async db=>{
  await this.principalWithin(db,actor);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912391))',[this.endpoint+':operations:'+selection.operationId]);
  const old=(await db.query('SELECT * FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,selection.operationId])).rows[0];
  if(old){if(old.operator_id!==actor.operatorId||old.action!==action||!isDeepStrictEqual(old.selection,selection))operationsFail('business_admin_operation_conflict');return {...old.result,replayed:true};}
  const result={...await fn(db,actor),operationId:selection.operationId,recordedAt:operationsStamp(this.now())};
  await this.businessAdmin.recordWithin(db,actor,action,{operationId:selection.operationId,selection,result});return result;
 });}
 async changeVisibilityWithin(db,{kind,id,expectedVersion,sourceVersion,input}){
  if(expectedVersion!==sourceVersion)operationsFail('operations_source_changed');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912392))',[this.endpoint+':'+kind+':'+id]);
  const old=await operationsVisibilityWithin(db,{endpoint:this.endpoint,kind,id,now:this.now()});
  if(old.version!==input.expectedVisibilityVersion)operationsFail('operations_visibility_changed');
  if(!Number.isSafeInteger(this.maxHideSeconds)||this.maxHideSeconds<1)operationsFail('operations_policy_unavailable',503);
  if(input.kind==='hide'&&(input.until<=this.now()||input.until>this.now()+this.maxHideSeconds))operationsFail('operations_hide_expiry',400);
  if(input.kind==='restore'&&!old.hidden)operationsFail('operations_visibility_changed');
  const until=input.kind==='hide'?operationsStamp(input.until):null;
  await db.query(`INSERT INTO operations_content_visibility_v1(endpoint,target_kind,target_id,revision,hidden_until,operation_id,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(endpoint,target_kind,target_id) DO UPDATE
   SET revision=EXCLUDED.revision,hidden_until=EXCLUDED.hidden_until,operation_id=EXCLUDED.operation_id,updated_at=EXCLUDED.updated_at`,
  [this.endpoint,kind,id,old.version+1,until,input.operationId,operationsStamp(this.now())]);
  return {target:{kind,id},sourceVersion,visibility:{version:old.version+1,hidden:input.kind==='hide',until,operationId:input.operationId},sourcePermissionChanged:false};
 }
}
