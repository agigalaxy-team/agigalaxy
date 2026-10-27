import {createHash} from 'node:crypto';
import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsPermissionCatalog} from "../../operations-permission-catalog.mjs";
import {operationsPermissionsHistorySchema} from "../../shared/operations-permissions-schema.mjs";
import {fail,parse} from './helpers.mjs';
import {stamp,roleView,roleUsageWithin,assignmentView,automationView} from './views.mjs';
import {safeDelta,changedFieldNames} from './history-delta.mjs';
import {OperationsPermissionsAuthority} from './authority.mjs';
import {automationAiOptionsWithin,automationAiBindingWithin} from './ai-binding.mjs';

// Authorized role/personnel/automation directories and strictly projected original permission history.
export class OperationsPermissionsReadModel extends OperationsPermissionsAuthority{
 constructor({aiWorkAccounts=null,...options}){super(options);this.aiWorkAccounts=aiWorkAccounts;}
 metadata(actor){const p=actor.businessAuthorization.permissions;return {checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true,
  permissions:{canManageRoles:p.includes('permissions.roles.write'),canManageAssignments:p.includes('permissions.assignments.write'),canManageAutomation:p.includes('permissions.automation.write')}};}
 async read(operator,fn){return transaction(this.db,async db=>{const actor=await this.requireAction(operator,'permissions.read',{db});return {...await fn(db,actor),...this.metadata(actor)};});}
 catalogVersion(actor){return createHash('sha256').update(JSON.stringify({items:operationsPermissionCatalog,permissions:this.metadata(actor).permissions})).digest('hex');}
 catalog(operator){return this.read(operator,async(_db,actor)=>({items:operationsPermissionCatalog,sourceVersion:this.catalogVersion(actor)}));}
 catalogLease(operator,version){return this.read(operator,async(_db,actor)=>{const sourceVersion=this.catalogVersion(actor);return {unchanged:version===sourceVersion,sourceVersion};});}
 roles(operator){return this.read(operator,async db=>{const rows=(await db.query('SELECT * FROM operations_business_roles_v1 WHERE endpoint=$1 ORDER BY created_at,id',[this.endpoint])).rows,items=[];for(const row of rows)items.push({...roleView(row),...await roleUsageWithin(db,this.endpoint,row.id)});return{items,nextAfter:null};});}
 role(operator,id){return this.read(operator,async db=>{const row=(await db.query('SELECT * FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id])).rows[0];if(!row)fail('operations_role_not_found',404);return {role:{...roleView(row),...await roleUsageWithin(db,this.endpoint,row.id)}};});}
 personnel(operator){return this.read(operator,async db=>{
  const people=(await db.query('SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 ORDER BY operator_id',[this.endpoint])).rows;
  const assignments=(await db.query('SELECT * FROM operations_role_assignments_v1 WHERE endpoint=$1 ORDER BY created_at,id',[this.endpoint])).rows;
  const items=[];
  for(const person of people){let effective=null,authorizationState='unknown',managementEligibility='unknown';
   try{const actual=await this.effective({kind:'business-operator',operatorId:person.operator_id,endpoint:this.endpoint},{db,includeManagementEligibility:true});managementEligibility=actual.managementEligibility??'unknown';effective={version:actual.version,permissions:actual.permissions,source:actual.source};authorizationState='available';}
   catch(error){if(error instanceof ServiceError&&error.status===403)authorizationState='not-eligible';}
   items.push({operatorId:person.operator_id,displayName:person.display_name,identityState:'known-management-principal',assignments:assignments.filter(a=>a.operator_id===person.operator_id).map(assignmentView),authorizationState,effective,managementEligibility});
  }
  return {items,nextAfter:null};
 });}
 automation(operator){return this.read(operator,async(db,actor)=>{let runtime=null;try{runtime=await this.runtimeStatus?.();}catch{runtime={state:'unavailable',modelState:'unknown'};}
  const rows=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 ORDER BY created_at,id',[this.endpoint])).rows,items=[];
  for(const row of rows)items.push(automationView(row,runtime,await automationAiBindingWithin(db,{endpoint:this.endpoint,aiWorkAccounts:this.aiWorkAccounts,row})));
  const aiAccountOptions=await automationAiOptionsWithin(db,{endpoint:this.endpoint,aiWorkAccounts:this.aiWorkAccounts,actor});
  return {items,aiAccountOptions,nextAfter:null,
   execution:{state:runtime?.state??'not-connected',available:runtime?.state==='connected',modelState:runtime?.modelState??'not-configured',automaticTriggers:'not-connected'}};
 });}
 history(operator,input={}){const x=parse(operationsPermissionsHistorySchema,input);return this.read(operator,async db=>{
  const rows=(await db.query(`SELECT e.id,e.sequence,e.kind,e.operator_id,e.resource_id,e.version,e.changed_fields,e.created_at,e.result->'delta' AS delta,
   NULLIF(BTRIM(o.display_name),'') AS operator_display_name,a.operator_id AS assignment_operator_id,a.role_id AS assignment_role_id,
   NULLIF(BTRIM(person.display_name),'') AS assignment_operator_display_name FROM operations_permission_events_v1 e
   LEFT JOIN operations_role_assignments_v1 a ON e.kind='assignment-save' AND a.id=e.resource_id AND a.endpoint=e.endpoint
   LEFT JOIN operations_operator_principals_v1 o ON o.operator_id=e.operator_id AND o.endpoint=e.endpoint
   LEFT JOIN operations_operator_principals_v1 person ON person.operator_id=a.operator_id AND person.endpoint=e.endpoint
   WHERE e.endpoint=$1 AND ($2::bigint IS NULL OR e.sequence<$2) AND ($3::uuid IS NULL OR e.resource_id=$3) ORDER BY e.sequence DESC LIMIT $4`,[this.endpoint,x.after??null,x.resourceId??null,x.limit+1])).rows;
  return {items:rows.slice(0,x.limit).map(row=>{const delta=safeDelta(row);return {id:row.id,sequence:String(row.sequence),kind:row.kind,operatorId:row.operator_id,operatorDisplayName:row.operator_display_name??null,resourceId:row.resource_id,version:row.version,
   changedFields:row.changed_fields.filter(field=>changedFieldNames.has(field)),delta,assignmentOperatorDisplayName:delta?.kind==='assignment'?row.assignment_operator_display_name??null:null,createdAt:stamp(row.created_at)};}),nextAfter:rows.length>x.limit?String(rows[x.limit-1].sequence):null};
 });}
}
