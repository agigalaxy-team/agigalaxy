import {transaction} from './database.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operatorId=/^[0-9a-f]{64}$/;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};

// Historical links come only from the exact immutable assignment event. Never
// infer a person or role from today's assignment/role state, or trust extra
// fields that happen to exist in an old generic audit selection.
export async function withPermissionAuditLinks(pool,{endpoint,rows}){
 const base=rows.map(row=>{
  if(row.action!=='permission-assignment-save')return row;
  const {targetOperatorId:_targetOperatorId,roleId:_roleId,...selection}=object(row.selection);
  return {...row,selection};
 });
 const candidates=base.filter(row=>row.endpoint===endpoint&&row.action==='permission-assignment-save'
  &&row.actor_kind==='business-operator'&&uuid.test(row.id??'')&&uuid.test(row.operation_id??'')
  &&operatorId.test(row.operator_id??'')&&uuid.test(row.selection.resourceId??''));
 if(!candidates.length)return base;
 let links;
 try{
  // The callers pass the top-level pool after their snapshot-capture tx has
  // ended. This optional lookup owns a separate read-only transaction: an SQL
  // failure is rolled back before returning the original audit material.
  links=await transaction(pool,async db=>{
   await db.query('SET TRANSACTION READ ONLY');
   return (await db.query(`SELECT a.id AS audit_id,e.id AS operation_id,e.operator_id,e.resource_id,
    e.input->>'operatorId' AS target_operator_id,lower(e.input->>'roleId') AS role_id
    FROM business_admin_audit_v1 a JOIN operations_permission_events_v1 e
     ON e.endpoint=a.endpoint AND e.id=a.operation_id AND e.operator_id=a.operator_id
     AND e.kind='assignment-save' AND e.resource_id::text=lower(a.selection->>'resourceId')
    WHERE a.endpoint=$1 AND a.id=ANY($2::uuid[]) AND a.action='permission-assignment-save'
     AND a.actor_kind='business-operator'
     AND jsonb_typeof(e.input->'operatorId')='string' AND e.input->>'operatorId' ~ '^[0-9a-f]{64}$'
     AND jsonb_typeof(e.input->'roleId')='string'
     AND e.input->>'roleId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND lower(e.input->>'operationId')=e.id::text AND lower(e.result->>'operationId')=e.id::text
     AND (NOT(e.input?'id') OR lower(e.input->>'id')=e.resource_id::text)
     AND e.input->'expectedVersion'=to_jsonb(e.version-1)
     AND a.selection->'expectedVersion'=e.input->'expectedVersion'
     AND e.result->'assignment'->>'id'=e.resource_id::text
     AND e.result->'assignment'->>'operatorId'=e.input->>'operatorId'
     AND e.result->'assignment'->>'roleId'=lower(e.input->>'roleId')
     AND e.result->'assignment'->'version'=to_jsonb(e.version) AND a.result->'version'=to_jsonb(e.version)
     AND jsonb_typeof(e.input->'enabled')='boolean'
     AND e.result->'assignment'->'enabled'=e.input->'enabled' AND a.result->'enabled'=e.input->'enabled'`,
    [endpoint,candidates.map(row=>row.id)])).rows;
  });
 }catch{return base;}
 const byId=new Map(links.map(link=>[link.audit_id,link]));
 return base.map(row=>{
  const link=byId.get(row.id);
  if(!link||link.operation_id!==row.operation_id||link.operator_id!==row.operator_id
   ||link.resource_id!==row.selection.resourceId.toLowerCase()||!operatorId.test(link.target_operator_id??'')||!uuid.test(link.role_id??''))return row;
  return {...row,selection:{...row.selection,targetOperatorId:link.target_operator_id,roleId:link.role_id}};
 });
}
