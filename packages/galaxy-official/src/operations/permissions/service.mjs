import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {transaction} from "../../infrastructure/database.mjs";
import {operationsPermissionCatalog} from "../../operations-permission-catalog.mjs";
import {operationsRoleSaveSchema,operationsAssignmentSaveSchema,operationsAutomationSaveSchema,operationsPermissionsHistorySchema} from "../../shared/operations-permissions-schema.mjs";
import {fail,parse,identity} from './helpers.mjs';
import {stamp,roleView,assignmentView,automationView} from './views.mjs';
import {codesChanged,sameSet} from './history-delta.mjs';
import {OperationsPermissionsReadModel} from './read-model.mjs';
import {safeDelta,changedFieldNames} from './history-delta.mjs';
import {automationScopeForSave,automationScopeDelta} from '../../shared/operations-automation-scope.mjs';
import {automationAiIdForSaveWithin,automationAiBindingWithin} from './ai-binding.mjs';
import {OperationsAiRoleDelegation} from './ai-delegation.mjs';
import {OperationsAiWorkPrompts} from './ai-work-prompts.mjs';
import {managementCapabilitiesWithin} from './ai-management-capabilities.mjs';

const receiptUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function operationReceipt(row){
 const schemas={'role-save':operationsRoleSaveSchema,'assignment-save':operationsAssignmentSaveSchema,'automation-save':operationsAutomationSaveSchema},parsed=schemas[row.kind]?.safeParse(row.input);
 if(!parsed?.success)fail('operations_permissions_receipt_unavailable',503);
 const x=parsed.data,selection={id:x.id??null,expectedVersion:x.expectedVersion};let result;
 const string=value=>{if(typeof value!=='string')fail('operations_permissions_receipt_unavailable',503);return value;};
 const number=value=>{if(!Number.isSafeInteger(value)||value<0)fail('operations_permissions_receipt_unavailable',503);return value;};
 const boolean=value=>{if(typeof value!=='boolean')fail('operations_permissions_receipt_unavailable',503);return value;};
 const strings=value=>{if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))fail('operations_permissions_receipt_unavailable',503);return [...value];};
 const fields=value=>({id:string(value.id),name:string(value.name),enabled:boolean(value.enabled),version:number(value.version),permissions:strings(value.permissions),createdAt:string(value.createdAt),updatedAt:string(value.updatedAt)});
 if(row.kind==='role-save'){
  Object.assign(selection,{name:x.name,description:x.description,enabled:x.enabled,permissions:[...x.permissions]});
  const saved=row.result?.role;if(!saved)fail('operations_permissions_receipt_unavailable',503);result={role:{...fields(saved),description:string(saved.description)}};
  if(x.subjectScope!==undefined)selection.subjectScope=x.subjectScope;if(saved.subjectScope!==undefined)result.role.subjectScope=saved.subjectScope;
 }else if(row.kind==='assignment-save'){
  Object.assign(selection,{operatorId:x.operatorId,roleId:x.roleId,enabled:x.enabled});
  const saved=row.result?.assignment;if(!saved)fail('operations_permissions_receipt_unavailable',503);result={assignment:{id:string(saved.id),operatorId:string(saved.operatorId),roleId:string(saved.roleId),enabled:boolean(saved.enabled),version:number(saved.version),createdAt:string(saved.createdAt),updatedAt:string(saved.updatedAt)}};
 }else{
  Object.assign(selection,{name:x.name,executorKind:x.executorKind,mode:x.mode,enabled:x.enabled,permissions:[...x.permissions],resourceIds:[...x.resourceIds]});
  if(Object.hasOwn(x,'resourceScope'))selection.resourceScope=x.resourceScope.kind==='selected'?{kind:'selected',resourceIds:[...x.resourceScope.resourceIds]}:{kind:x.resourceScope.kind};
  if(x.aiAccountId!==undefined)selection.aiAccountId=x.aiAccountId;
  const saved=row.result?.automation;if(!saved||!['program','ai'].includes(saved.executorKind)||!['assisted','automatic'].includes(saved.mode)||!['not-connected','model-not-configured','awaiting-trigger','connected','unavailable'].includes(saved.executionState))fail('operations_permissions_receipt_unavailable',503);
  const resourceScope=saved.resourceScope?.kind==='selected'?{kind:'selected',resourceIds:strings(saved.resourceScope.resourceIds)}:saved.resourceScope?.kind==='eligible'?{kind:'eligible'}:saved.resourceScope?.kind==='unresolved'||!saved.resourceIds.length?{kind:'unresolved'}:{kind:'selected',resourceIds:strings(saved.resourceIds)};
  const aiAccountId=saved.aiAccountId??null,bindingState=saved.bindingState??(saved.executorKind==='ai'?'unassigned':'not-applicable');
  if(aiAccountId!==null&&!receiptUuid.test(aiAccountId)||!['not-applicable','unassigned','bound','disabled','role-exceeded','unsupported','unavailable'].includes(bindingState)||saved.executorKind==='program'&&aiAccountId!==null)fail('operations_permissions_receipt_unavailable',503);
  let aiAccount=null;
  if(saved.aiAccount){const item=saved.aiAccount;if(item.id!==aiAccountId||!['overview','governance','messaging','discovery','maintenance'].includes(item.domain)||typeof item.name!=='string'||!item.name.trim()||item.name.length>100||/[\p{Cc}]/u.test(item.name)||typeof item.enabled!=='boolean')fail('operations_permissions_receipt_unavailable',503);aiAccount={id:item.id,domain:item.domain,name:item.name,enabled:item.enabled};}
  if(saved.executorKind==='program'?(bindingState!=='not-applicable'||aiAccount!==null):aiAccountId===null?(bindingState!=='unassigned'||aiAccount!==null):['not-applicable','unassigned'].includes(bindingState)||bindingState!=='unavailable'&&aiAccount===null)fail('operations_permissions_receipt_unavailable',503);
  result={automation:{...fields(saved),executorKind:saved.executorKind,mode:saved.mode,resourceIds:strings(saved.resourceIds),resourceScope,executionState:saved.executionState,executionAvailable:boolean(saved.executionAvailable),aiAccountId,bindingState,aiAccount}};
 }
 return {state:'recorded',operationId:row.id,operatorId:row.operator_id,kind:row.kind,selection,result:{...result,operationId:row.id,recordedAt:stamp(row.created_at),replayed:true}};
}

// Versioned role, assignment and automation commands with fresh authority before original-intent replay.
export class OperationsPermissionsService extends OperationsPermissionsReadModel{
 constructor(options){super(options);this.aiRoleDelegation=new OperationsAiRoleDelegation(this);this.aiWorkPrompts=new OperationsAiWorkPrompts(this);}
 delegation(operator){return this.aiRoleDelegation.read(operator);}
 saveDelegation(operator,input,options){return this.aiRoleDelegation.save(operator,input,options);}
 delegationOperation(operator,operationId){return this.aiRoleDelegation.operation(operator,operationId);}
 delegationAvailabilityWithin(db,options){return this.aiRoleDelegation.availabilityWithin(db,options);}
 delegatedDirectory(actor){return this.aiRoleDelegation.directory(actor);}
 delegatedRoleSave(actor,input,options){return this.aiRoleDelegation.command(actor,input,options);}
 delegatedAssignment(actor,input,options){return this.aiRoleDelegation.command(actor,input,options);}
 delegatedRolePreparation(actor,input){return this.aiRoleDelegation.prepareRole(actor,input);}
 delegatedManagementOperation(actor,id,options){return this.aiRoleDelegation.managementOperation(actor,id,options);}
 delegatedPrompt(actor,input){return this.aiWorkPrompts.read(actor,input);}
 delegatedPromptSave(actor,input,options){return this.aiWorkPrompts.save(actor,input,options);}
 managementCapabilitiesWithin(db,options){return managementCapabilitiesWithin(this,db,options);}
 history(operator,input={}){
  const x=parse(operationsPermissionsHistorySchema,input);if(!x.targetOperatorId)return super.history(operator,x);
  return this.read(operator,async db=>{
   if(!(await db.query('SELECT 1 FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[this.endpoint,x.targetOperatorId])).rows.length)fail('operations_person_not_found',404);
   const rows=(await db.query(`SELECT e.id,e.sequence,e.kind,e.operator_id,e.resource_id,e.version,e.changed_fields,e.created_at,e.result->'delta' AS delta,
    NULLIF(BTRIM(o.display_name),'') AS operator_display_name,a.operator_id AS assignment_operator_id,a.role_id AS assignment_role_id,
    NULLIF(BTRIM(person.display_name),'') AS assignment_operator_display_name FROM operations_permission_events_v1 e
    JOIN operations_role_assignments_v1 a ON e.kind='assignment-save' AND a.id=e.resource_id AND a.endpoint=e.endpoint
    LEFT JOIN operations_operator_principals_v1 o ON o.operator_id=e.operator_id AND o.endpoint=e.endpoint
    LEFT JOIN operations_operator_principals_v1 person ON person.operator_id=a.operator_id AND person.endpoint=e.endpoint
    WHERE e.endpoint=$1 AND a.operator_id=$2 AND ($3::bigint IS NULL OR e.sequence<$3) AND ($4::uuid IS NULL OR e.resource_id=$4)
    ORDER BY e.sequence DESC LIMIT $5`,[this.endpoint,x.targetOperatorId,x.after??null,x.resourceId??null,x.limit+1])).rows;
   return {items:rows.slice(0,x.limit).map(row=>{const delta=safeDelta(row);return {id:row.id,sequence:String(row.sequence),kind:row.kind,operatorId:row.operator_id,operatorDisplayName:row.operator_display_name??null,resourceId:row.resource_id,version:row.version,changedFields:row.changed_fields.filter(field=>changedFieldNames.has(field)),delta,assignmentOperatorDisplayName:delta?.kind==='assignment'?row.assignment_operator_display_name??null:null,createdAt:stamp(row.created_at)};}),nextAfter:rows.length>x.limit?String(rows[x.limit-1].sequence):null};
  });
 }
 operation(operator,operationId){
  if(typeof operationId!=='string'||!receiptUuid.test(operationId))fail('invalid_operations_permissions_request',400);
  return this.read(operator,async(db,actor)=>{
   const row=(await db.query('SELECT id,operator_id,kind,input,result,created_at FROM operations_permission_events_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,operationId])).rows[0];
   if(!row)return {state:'not-recorded',operationId};
   if(row.operator_id!==actor.operatorId)fail('operations_permissions_operation_not_found',404);
   return operationReceipt(row);
  });
 }
 async command(operator,action,kind,input,operation,{authorize=null}={}){
  const original=identity(operator,this.endpoint);if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const current=async db=>{const fresh=identity(await authorize(),this.endpoint);if(fresh.operatorId!==original.operatorId)fail('business_admin_denied');return this.requireAction(fresh,action,{db});};
  await current(this.db);
  return transaction(this.db,async db=>{
   // All grant mutations serialize before taking the authority row write lock.
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))',[this.endpoint]);
   await db.query('INSERT INTO operations_permission_authority_v1(endpoint,version) VALUES($1,0) ON CONFLICT DO NOTHING',[this.endpoint]);
   await db.query('SELECT version FROM operations_permission_authority_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint]);
   const actor=await current(db);
   const old=(await db.query('SELECT * FROM operations_permission_events_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,input.operationId])).rows[0];
   if(old){if(old.operator_id!==actor.operatorId||old.kind!==kind||!isDeepStrictEqual(old.input,input))fail('operations_permissions_operation_conflict',409);return {...old.result,replayed:true};}
   const {result,resourceId,version,changedFields,enabled,permissionCount,delta}=await operation(db,actor);
   // The just-authorized mutation may intentionally revoke the operator's own
   // role. Recheck identity/management eligibility without undoing that revoke.
   const fresh=identity(await authorize(),this.endpoint);if(fresh.operatorId!==original.operatorId)fail('business_admin_denied');
   await this.effective(fresh,{db});
   await db.query('UPDATE operations_permission_authority_v1 SET version=version+1 WHERE endpoint=$1',[this.endpoint]);
   const at=stamp(this.now()*1000),receipt={...result,delta,operationId:input.operationId,recordedAt:at,replayed:false};
   await db.query(`INSERT INTO operations_permission_events_v1(id,endpoint,operator_id,kind,resource_id,version,changed_fields,input,result,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[input.operationId,this.endpoint,actor.operatorId,kind,resourceId,version,changedFields,JSON.stringify(input),JSON.stringify(receipt),at]);
   await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),this.endpoint,actor.operatorId,actor.role,'permission-'+kind,input.operationId,actor.httpRequestId,
    JSON.stringify({resourceId,expectedVersion:input.expectedVersion,changedFields}),JSON.stringify({version,enabled,...(permissionCount===undefined?{}:{permissionCount})}),at]);
   return receipt;
  });
 }
 subset(actor,permissions){if(permissions.some(code=>!actor.businessAuthorization.permissions.includes(code)))fail('operations_permission_grant_exceeds_authority');}
 async saveRole(operator,input,options){const x=parse(operationsRoleSaveSchema,input);return this.command(operator,'permissions.roles.write','role-save',x,async(db,actor)=>{
  const old=x.id?(await db.query('SELECT * FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,x.id])).rows[0]:null;
  if(x.id&&!old)fail('operations_role_not_found',404);if((old?.version??0)!==x.expectedVersion)fail('operations_permissions_version_changed',409);
  const subjectScope=x.subjectScope??old?.subject_scope??'shared';if(old&&(old.subject_scope??'shared')!==subjectScope)fail('operations_role_scope_immutable',409);
  this.subset(actor,x.permissions);const id=old?.id??randomUUID(),version=(old?.version??0)+1,at=stamp(this.now()*1000);
  if((await db.query('SELECT 1 FROM operations_business_roles_v1 WHERE endpoint=$1 AND name=$2 AND id<>$3',[this.endpoint,x.name,id])).rows.length)fail('operations_role_name_conflict',409);
  const row=(await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,version=EXCLUDED.version,permissions=EXCLUDED.permissions,updated_by=EXCLUDED.updated_by,updated_by_ai_account_id=NULL,updated_at=EXCLUDED.updated_at RETURNING *`,[id,this.endpoint,x.name,x.description,x.enabled,version,x.permissions,actor.operatorId,at])).rows[0];
  if(!old&&subjectScope==='ai-only'){await db.query("UPDATE operations_business_roles_v1 SET subject_scope='ai-only' WHERE endpoint=$1 AND id=$2",[this.endpoint,id]);row.subject_scope='ai-only';}
  const fields=['name','description','enabled','permissions'].filter(key=>!old||(key==='permissions'?!sameSet(old.permissions,x.permissions):!isDeepStrictEqual(old[key],x[key])));
  return {result:{role:roleView(row)},resourceId:id,version,changedFields:fields,enabled:x.enabled,permissionCount:x.permissions.length,
   delta:{kind:'role',permissions:codesChanged(old?.permissions,x.permissions),enabled:{before:old?.enabled??null,after:x.enabled}}};
 },options);}
 async saveAssignment(operator,input,options){const x=parse(operationsAssignmentSaveSchema,input);return this.command(operator,'permissions.assignments.write','assignment-save',x,async(db,actor)=>{
  if(typeof options?.authorizeTarget==='function')await options.authorizeTarget(db,actor);
  if(!(await db.query('SELECT 1 FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[this.endpoint,x.operatorId])).rows.length)fail('operations_person_not_found',404);
  const role=(await db.query('SELECT * FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[this.endpoint,x.roleId])).rows[0];if(!role)fail('operations_role_not_found',404);
  if(x.enabled&&role.enabled!==true)fail('operations_permissions_target_changed',409);
  if(x.enabled&&role.subject_scope==='ai-only')fail('operations_ai_role_human_assignment_denied');
  if(x.enabled)this.subset(actor,role.permissions);
  const old=x.id?(await db.query('SELECT * FROM operations_role_assignments_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,x.id])).rows[0]:null;
  if(x.id&&!old)fail('operations_assignment_not_found',404);if((old?.version??0)!==x.expectedVersion)fail('operations_permissions_version_changed',409);
  if(old&&(old.operator_id!==x.operatorId||old.role_id!==x.roleId))fail('operations_permissions_target_changed',409);
  if(!old&&(await db.query('SELECT 1 FROM operations_role_assignments_v1 WHERE endpoint=$1 AND operator_id=$2 AND role_id=$3',[this.endpoint,x.operatorId,x.roleId])).rows.length)fail('operations_assignment_exists',409);
  const id=old?.id??randomUUID(),version=(old?.version??0)+1,at=stamp(this.now()*1000),row=(await db.query(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$8) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING *`,[id,this.endpoint,x.operatorId,x.roleId,x.enabled,version,actor.operatorId,at])).rows[0];
  return {result:{assignment:assignmentView(row)},resourceId:id,version,changedFields:old?(old.enabled===x.enabled?[]:['enabled']):['operatorId','roleId','enabled'],enabled:x.enabled,
   delta:{kind:'assignment',operatorId:row.operator_id,roleId:row.role_id,enabled:{before:old?.enabled??null,after:x.enabled}}};
 },options);}
 async saveAutomation(operator,input,options){const x=parse(operationsAutomationSaveSchema,input);return this.command(operator,'permissions.automation.write','automation-save',x,async(db,actor)=>{
  this.subset(actor,x.permissions);
  if(x.permissions.some(code=>operationsPermissionCatalog.find(item=>item.code===code)?.humanOnly))fail('operations_automation_human_boundary');
  const old=x.id?(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,x.id])).rows[0]:null;
  if(x.id&&!old)fail('operations_automation_not_found',404);if((old?.version??0)!==x.expectedVersion)fail('operations_permissions_version_changed',409);
  const aiAccountId=await automationAiIdForSaveWithin(db,{endpoint:this.endpoint,aiWorkAccounts:this.aiWorkAccounts,input:x,old});
  const scope=automationScopeForSave(x,old);
  const id=old?.id??randomUUID(),version=(old?.version??0)+1,at=stamp(this.now()*1000),row=(await db.query(`INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,resource_scope_kind,created_by,updated_by,created_at,updated_at,ai_account_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$12,$13) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,executor_kind=EXCLUDED.executor_kind,mode=EXCLUDED.mode,enabled=EXCLUDED.enabled,version=EXCLUDED.version,permissions=EXCLUDED.permissions,resource_ids=EXCLUDED.resource_ids,resource_scope_kind=EXCLUDED.resource_scope_kind,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at,ai_account_id=EXCLUDED.ai_account_id RETURNING *`,[id,this.endpoint,x.name,x.executorKind,x.mode,x.enabled,version,x.permissions,scope.resourceIds,scope.resourceScopeKind,actor.operatorId,at,aiAccountId])).rows[0];
  const fields=['name','executorKind','mode','enabled','permissions'].filter(key=>!old||(key==='permissions'?!sameSet(old.permissions,x.permissions):old[key==='executorKind'?'executor_kind':key]!==x[key])),scopeDelta=automationScopeDelta(old,row);
  if(!old||!isDeepStrictEqual(scopeDelta.before,scopeDelta.after))fields.push('resourceScope');
  if((old?.ai_account_id??null)!==aiAccountId)fields.push('aiAccountId');
  const binding=await automationAiBindingWithin(db,{endpoint:this.endpoint,aiWorkAccounts:this.aiWorkAccounts,row});
  return {result:{automation:automationView(row,null,binding)},resourceId:id,version,changedFields:fields,enabled:x.enabled,permissionCount:x.permissions.length,
   delta:{kind:'automation',permissions:codesChanged(old?.permissions,x.permissions),enabled:{before:old?.enabled??null,after:x.enabled},scope:scopeDelta,
    mode:{before:old?.mode??null,after:x.mode},executorKind:{before:old?.executor_kind??null,after:x.executorKind},aiAccountId:{before:old?.ai_account_id??null,after:aiAccountId}}};
 },options);}
}
