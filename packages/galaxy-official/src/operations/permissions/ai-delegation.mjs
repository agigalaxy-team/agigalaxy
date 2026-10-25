import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from '../../database.mjs';
import {operationsPermissionCatalog} from '../../operations-permission-catalog.mjs';
import {aiRoleDelegationSaveSchema,delegatedAiRoleCommandSchema,delegatedAiRolePreparationSchema} from './ai-delegation-schema.mjs';
import {roleView,roleUsageWithin} from './views.mjs';
import {fail,parse,identity} from './helpers.mjs';
import {businessAuditActorContext} from '../../business-admin-audit-attribution.mjs';
import {operationsAiWorkScope} from '../../shared/operations-ai-use.mjs';

const subset=(items,ceiling)=>items.every(item=>ceiling.includes(item));
const zOperation=z.uuid();
const humanOnly=new Set(operationsPermissionCatalog.filter(row=>row.humanOnly).map(row=>row.code));
const safeCeiling=items=>items.every(code=>!humanOnly.has(code)&&!code.startsWith('ai.roles.')&&!code.startsWith('ai.prompts.')&&!code.startsWith('ai.delegation.')&&!code.startsWith('ai.accounts.')&&!code.startsWith('ai.use.'));
const view=row=>row?{id:row.id,sourceAiAccountId:row.source_ai_account_id,version:row.version,enabled:row.enabled,targetAiAccountIds:row.target_ai_account_ids,grantablePermissions:row.grantable_permissions,allowedManagementActions:row.allowed_management_actions,updatedAt:new Date(row.updated_at).toISOString()}:null;

// Human delegation is an explicit, versioned ceiling. Actual AI role rights
// and enabled duty/task state are checked again for every read and mutation.
export class OperationsAiRoleDelegation{
 constructor(owner){this.owner=owner;this.db=owner.db;this.endpoint=owner.endpoint;}
 async human(operator,action,{db=this.db,authorize=null}={}){
  let actor=operator;if(authorize){actor=await authorize();if(identity(actor,this.endpoint).operatorId!==identity(operator,this.endpoint).operatorId)fail('business_admin_denied');}
  if(actor?.kind!=='business-operator')fail('business_admin_denied');return this.owner.requireAction(actor,action,{db});
 }
 async account(db,id){const row=(await db.query('SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,id])).rows[0];if(!row)fail('operations_ai_work_not_initialized',409);return row;}
 async source(db){const row=(await db.query("SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain='overview'",[this.endpoint])).rows[0];if(!row)fail('operations_ai_work_not_initialized',409);return row;}
 async current(db,sourceId){return(await db.query('SELECT * FROM operations_ai_role_delegations_v1 WHERE endpoint=$1 AND source_ai_account_id=$2',[this.endpoint,sourceId])).rows[0]??null;}
 async read(operator){return transaction(this.db,async db=>{const actor=await this.human(operator,'ai.delegation.read',{db}),source=await this.source(db),row=await this.current(db,source.id),targets=(await db.query("SELECT id,domain,name,enabled FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain<>'overview' ORDER BY domain",[this.endpoint])).rows;await this.human(actor,'ai.delegation.read',{db});return{delegation:view(row),sourceAiAccount:source,targetAiAccounts:targets,checkedAt:this.owner.now(),readExpiresAt:this.owner.now()+30};});}
 async operation(operator,operationId){parse(zOperation,operationId);return transaction(this.db,async db=>{const actor=await this.human(operator,'ai.delegation.read',{db}),row=(await db.query("SELECT actor_kind,actor_id,kind,selection,result FROM operations_ai_role_delegation_events_v1 WHERE endpoint=$1 AND operation_id=$2",[this.endpoint,operationId])).rows[0];if(!row)return{state:'not-recorded',operationId};if(row.actor_kind!=='business-operator'||row.actor_id!==actor.operatorId||row.kind!=='config-save')fail('operations_ai_delegation_operation_not_found',404);return{state:'recorded',operationId,selection:row.selection,result:{...row.result,replayed:true}};});}
 async replay(db,actor,operationId,kind,selection){const old=(await db.query('SELECT * FROM operations_ai_role_delegation_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];if(!old)return null;if(old.actor_kind!==actor.kind||old.actor_id!==actor.operatorId||old.kind!==kind||!isDeepStrictEqual(old.selection,selection))fail('operations_ai_delegation_operation_conflict',409);return{...old.result,replayed:true};}
 async record(db,actor,row,operationId,kind,selection,result){
  const value={...result,operationId,delegationVersion:row.version,recordedAt:new Date(this.owner.now()*1000).toISOString(),replayed:false};
  await db.query(`INSERT INTO operations_ai_role_delegation_events_v1(endpoint,operation_id,delegation_id,version,actor_kind,actor_id,kind,selection,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[this.endpoint,operationId,row.id,row.version,actor.kind,actor.operatorId,kind,JSON.stringify(selection),JSON.stringify(value),value.recordedAt]);
  const action={'config-save':'ai-delegation-save','role-create':'ai-role-create','role-update':'ai-role-update','assignment-save':'ai-role-assignment-save','prompt-save':'ai-prompt-save'}[kind],
   auditSelection={delegationId:row.id,delegationVersion:row.version,sourceAiAccountId:row.source_ai_account_id,roleId:result.role?.id??selection.roleId??null,aiAccountId:selection.aiAccountId??null},
   auditResult=kind==='prompt-save'?{revision:result.prompt.revision,promptVersion:result.prompt.promptVersion}:{enabled:result.role?.enabled??result.assignment?.enabled??row.enabled,version:result.role?.version??result.assignment?.version??row.version,permissionCount:result.role?.permissions?.length??row.grantable_permissions.length,targetCount:row.target_ai_account_ids.length};
  const context=businessAuditActorContext(this.owner.aiServiceAuthority,actor);
  await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11)`,[randomUUID(),this.endpoint,actor.operatorId,actor.role??null,action,operationId,JSON.stringify(auditSelection),JSON.stringify(auditResult),value.recordedAt,actor.kind,context?JSON.stringify(context):null]);
  return value;
 }
 async save(operator,input,{authorize}={}){
  const x=parse(aiRoleDelegationSaveSchema,input);if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);await this.human(operator,'ai.delegation.configure',{authorize});
  return transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))',[this.endpoint]);
   const actor=await this.human(operator,'ai.delegation.configure',{db,authorize}),source=await this.source(db),old=await this.current(db,source.id),saved=await this.replay(db,actor,x.operationId,'config-save',x);if(saved)return saved;
   if((old?.version??0)!==x.expectedVersion)fail('operations_ai_delegation_version_changed',409);
   if(x.targetAiAccountIds.includes(source.id)||!safeCeiling(x.grantablePermissions)||!subset(x.grantablePermissions,actor.businessAuthorization.permissions))fail('operations_ai_delegation_ceiling_denied');
   for(const id of x.targetAiAccountIds)await this.account(db,id);
   const at=new Date(this.owner.now()*1000),id=old?.id??randomUUID(),row=(await db.query(`INSERT INTO operations_ai_role_delegations_v1(id,endpoint,source_ai_account_id,version,enabled,target_ai_account_ids,grantable_permissions,allowed_management_actions,created_by,updated_by,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,target_ai_account_ids=EXCLUDED.target_ai_account_ids,grantable_permissions=EXCLUDED.grantable_permissions,allowed_management_actions=EXCLUDED.allowed_management_actions,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at RETURNING *`,[id,this.endpoint,source.id,(old?.version??0)+1,x.enabled,x.targetAiAccountIds,x.grantablePermissions,x.allowedManagementActions,actor.operatorId,at])).rows[0];
   await this.human(actor,'ai.delegation.configure',{db,authorize});await db.query('UPDATE operations_permission_authority_v1 SET version=version+1 WHERE endpoint=$1',[this.endpoint]);
   return this.record(db,actor,row,x.operationId,'config-save',x,{delegation:view(row)});
  });
 }
 async actorWithin(db,actor,managementAction,{expectedDelegationVersion=null}={}){
  const authority=this.owner.aiServiceAuthority,duty=authority?.acceptsDuty(actor),work=duty?null:operationsAiWorkScope(actor),read=['read','prompt-read'].includes(managementAction),permission=managementAction.startsWith('prompt-')?'ai.prompts.'+managementAction.slice(7):'ai.roles.'+managementAction;
  if(!authority||!duty&&!work)fail('business_admin_denied');
  actor=duty?await authority.requireDutyAction(actor,permission,{db,purpose:read?'query':'execution'}):await authority.human(actor,{db,action:permission,purpose:read?'query':'prepare'});
  const sourceAiAccountId=duty?actor.aiAccountId:work.accountId,domain=duty?actor.domain:work.domain;
  if(domain!=='overview')fail('operations_ai_delegation_source_denied');
  const row=await this.current(db,sourceAiAccountId),context=duty?authority.dutyContext(actor):null;
  if(!row?.enabled||!row.allowed_management_actions.includes(managementAction))fail('operations_ai_delegation_denied');
  if(context?.delegationVersion!=null&&context.delegationVersion!==row.version||expectedDelegationVersion!==null&&expectedDelegationVersion!==row.version)fail('operations_ai_delegation_version_changed',409);
  if(row.target_ai_account_ids.includes(sourceAiAccountId)||!safeCeiling(row.grantable_permissions))fail('operations_ai_delegation_ceiling_denied');
  if(duty&&managementAction==='prompt-update'){
   const task=(await db.query('SELECT configuration FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,context.taskId])).rows[0];
   if(!task?.configuration?.plan?.actions?.includes(permission))fail('operations_autonomy_scope_denied');
  }
  return{actor,row,sourceAiAccountId};
 }
 async availabilityWithin(db,{actor}){
  const authority=this.owner.aiServiceAuthority,duty=authority?.acceptsDuty(actor),work=duty?null:operationsAiWorkScope(actor);
  if(!authority||!duty&&!work)fail('business_admin_denied');
  const query=duty?await authority.requireDutyAction(actor,'workbench.read',{db,purpose:'query'}):await authority.human(actor,{db,action:'workbench.read',purpose:'query'}),
   execution=duty?await authority.requireDutyAction(actor,'workbench.read',{db,purpose:'execution'}):await authority.human(actor,{db,action:'workbench.read',purpose:'prepare'}),
   sourceAiAccountId=duty?actor.aiAccountId:work.accountId,domain=duty?actor.domain:work.domain;
  const empty={canRead:false,canReadRoles:false,canReadPrompts:false,managementActions:[],promptActions:[],targetAiAccountIds:[],delegationId:null,version:null};if(domain!=='overview')return empty;
  const row=await this.current(db,sourceAiAccountId),context=duty?authority.dutyContext(actor):null;
  if(!row?.enabled||context?.delegationVersion!=null&&context.delegationVersion!==row.version||row.target_ai_account_ids.includes(sourceAiAccountId)||!safeCeiling(row.grantable_permissions))return empty;
  const canReadRoles=row.allowed_management_actions.includes('read')&&query.businessAuthorization.permissions.includes('ai.roles.read'),canReadPrompts=row.allowed_management_actions.includes('prompt-read')&&query.businessAuthorization.permissions.includes('ai.prompts.read'),
   actions=['create','update','assign','revoke'].filter(action=>row.allowed_management_actions.includes(action)&&execution.businessAuthorization.permissions.includes('ai.roles.'+action)),
   promptActions=[...(canReadPrompts?['read']:[]),...(row.allowed_management_actions.includes('prompt-update')&&execution.businessAuthorization.permissions.includes('ai.prompts.update')?['update']:[])];
  return{canRead:canReadRoles,canReadRoles,canReadPrompts,managementActions:actions,promptActions,targetAiAccountIds:[...row.target_ai_account_ids],delegationId:row.id,version:row.version};
 }
 async roleWithin(db,delegation,id){
  const role=(await db.query('SELECT * FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2 FOR UPDATE',[this.endpoint,id])).rows[0];if(!role)fail('operations_role_not_found',404);
  if(role.subject_scope!=='ai-only'||!subset(role.permissions,delegation.grantable_permissions)||!subset(role.managed_ai_account_ids??[],delegation.target_ai_account_ids))fail('operations_ai_delegation_role_denied');
  if((await db.query('SELECT 1 FROM operations_role_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled LIMIT 1',[this.endpoint,id])).rows.length)fail('operations_ai_role_human_assignment_denied');
  const assignments=(await db.query('SELECT ai_account_id FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled',[this.endpoint,id])).rows;
  if(assignments.some(item=>item.ai_account_id===delegation.source_ai_account_id||!delegation.target_ai_account_ids.includes(item.ai_account_id)))fail('operations_ai_delegation_self_expansion_denied');
  // Even a temporarily disabled assignment to the source must not be made
  // stronger by editing its role and waiting for a later re-enable.
  if((await db.query('SELECT 1 FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND ai_account_id=$3 LIMIT 1',[this.endpoint,id,delegation.source_ai_account_id])).rows.length)fail('operations_ai_delegation_self_expansion_denied');
  return role;
 }
 async directory(actor){return transaction(this.db,async db=>{
  const availability=await this.availabilityWithin(db,{actor});if(!availability.canReadRoles&&!availability.canReadPrompts)fail('operations_ai_delegation_denied');
  const readAction=availability.canReadRoles?'read':'prompt-read',current=await this.actorWithin(db,actor,readAction),rows=availability.canReadRoles?(await db.query("SELECT id FROM operations_business_roles_v1 WHERE endpoint=$1 AND subject_scope='ai-only' ORDER BY name,id",[this.endpoint])).rows:[],roles=[];
  for(const item of rows){try{const role=await this.roleWithin(db,current.row,item.id);roles.push({...roleView(role),...await roleUsageWithin(db,this.endpoint,role.id)});}catch(error){if(error.status!==403)throw error;}}
  const targets=[];for(const id of current.row.target_ai_account_ids)targets.push(await this.account(db,id));
  const assignments=availability.canReadRoles?(await db.query('SELECT id,ai_account_id,role_id,enabled,version FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND ai_account_id=ANY($2::uuid[]) AND role_id=ANY($3::uuid[]) ORDER BY ai_account_id,id',[this.endpoint,current.row.target_ai_account_ids,roles.map(row=>row.id)])).rows.map(row=>({id:row.id,aiAccountId:row.ai_account_id,roleId:row.role_id,enabled:row.enabled,version:row.version})):[];
  await this.actorWithin(db,actor,readAction);return{delegation:view(current.row),targetAiAccounts:targets,roles,assignments,availability,checkedAt:this.owner.now(),readExpiresAt:this.owner.now()+30};
 });}
 async prepareRole(actor,input){
  const x=parse(delegatedAiRolePreparationSchema,input),action=x.kind==='role-create'?'create':x.kind==='role-update'?'update':x.enabled?'assign':'revoke';
  return transaction(this.db,async db=>{
   const current=await this.actorWithin(db,actor,action),delegation=current.row;let before=null;
   if(x.kind==='assignment-save'){
    if(!delegation.target_ai_account_ids.includes(x.aiAccountId)||x.aiAccountId===current.sourceAiAccountId)fail('operations_ai_delegation_target_denied');
    const role=await this.roleWithin(db,delegation,x.roleId),target=await this.account(db,x.aiAccountId);
    if(x.enabled&&(!role.enabled||!target.enabled||!(role.managed_ai_account_ids??[]).includes(x.aiAccountId)))fail('operations_ai_delegation_role_denied');
    const old=(await db.query('SELECT * FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND ai_account_id=$2 AND role_id=$3',[this.endpoint,x.aiAccountId,x.roleId])).rows[0];
    if(x.id?old?.id!==x.id||old.version!==x.expectedVersion:!!old||x.expectedVersion!==0||!x.enabled)fail('operations_ai_work_assignment_changed',409);
    before=old?{id:old.id,enabled:old.enabled,version:old.version}:null;
   }else{
    if(!subset(x.targetAiAccountIds,delegation.target_ai_account_ids)||x.targetAiAccountIds.includes(current.sourceAiAccountId)||!subset(x.permissions,delegation.grantable_permissions)||!safeCeiling(x.permissions))fail('operations_ai_delegation_ceiling_denied');
    for(const id of x.targetAiAccountIds)await this.account(db,id);
    const old=x.kind==='role-update'?await this.roleWithin(db,delegation,x.id):null;if((old?.version??0)!==x.expectedVersion)fail('operations_permissions_version_changed',409);
    if(old){const assigned=(await db.query('SELECT ai_account_id FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled',[this.endpoint,old.id])).rows;if(assigned.some(row=>!x.targetAiAccountIds.includes(row.ai_account_id)))fail('operations_ai_delegation_target_denied');before=roleView(old);}
   }
   await this.actorWithin(db,actor,action,{expectedDelegationVersion:delegation.version});
   return{command:x,before,delegationVersion:delegation.version,checkedAt:this.owner.now(),readExpiresAt:this.owner.now()+30};
  });
 }
 async managementOperation(actor,operationId,{kind=null,input=null}={}){
  parse(zOperation,operationId);return transaction(this.db,async db=>{
   const row=(await db.query('SELECT * FROM operations_ai_role_delegation_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0],readAction=(row?.kind??kind)==='prompt-save'?'prompt-read':'read',current=await this.actorWithin(db,actor,readAction);
   if(!row)return{state:'not-recorded',operationId};
   if(!['prompt-save','role-create','role-update','assignment-save'].includes(row.kind)||row.actor_kind!==current.actor.kind||row.actor_id!==current.actor.operatorId||row.delegation_id!==current.row.id||kind!==null&&row.kind!==kind||input!==null&&!isDeepStrictEqual(row.selection,input))fail('operations_ai_delegation_operation_not_found',404);
   const targets=row.kind==='prompt-save'||row.kind==='assignment-save'?[row.selection.aiAccountId]:row.selection.targetAiAccountIds;
   if(!Array.isArray(targets)||!subset(targets,current.row.target_ai_account_ids)||targets.includes(current.sourceAiAccountId))fail('operations_ai_delegation_target_denied');
   // The receipt body is already the original caller's closed typed command.
   // It is never substituted with today's configuration or a new operation.
   return{state:'recorded',operationId,kind:row.kind,selection:row.selection,result:{...row.result,replayed:true}};
  });
 }
 async command(actor,input,{expectedDelegationVersion=null}={}){
  const x=parse(delegatedAiRoleCommandSchema,input),action=x.kind==='role-create'?'create':x.kind==='role-update'?'update':x.enabled?'assign':'revoke';
  return transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))',[this.endpoint]);
   const current=await this.actorWithin(db,actor,action,{expectedDelegationVersion}),delegation=current.row;actor=current.actor;
   const replay=await this.replay(db,actor,x.operationId,x.kind,x);if(replay)return replay;
   let result;
   if(x.kind==='assignment-save'){
    if(!delegation.target_ai_account_ids.includes(x.aiAccountId)||x.aiAccountId===current.sourceAiAccountId)fail('operations_ai_delegation_target_denied');
    const role=await this.roleWithin(db,delegation,x.roleId),target=await this.account(db,x.aiAccountId);
    if(x.enabled&&(!role.enabled||!target.enabled||!(role.managed_ai_account_ids??[]).includes(x.aiAccountId)))fail('operations_ai_delegation_role_denied');
    const old=(await db.query('SELECT * FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND ai_account_id=$2 AND role_id=$3 FOR UPDATE',[this.endpoint,x.aiAccountId,x.roleId])).rows[0];
    if(x.id?old?.id!==x.id||old.version!==x.expectedVersion:!!old||x.expectedVersion!==0||!x.enabled)fail('operations_ai_work_assignment_changed',409);
    const id=old?.id??x.operationId,at=new Date(this.owner.now()*1000),saved=(await db.query(`INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at
     WHERE $8::boolean AND operations_ai_work_assignments_v1.endpoint=EXCLUDED.endpoint AND operations_ai_work_assignments_v1.ai_account_id=EXCLUDED.ai_account_id AND operations_ai_work_assignments_v1.role_id=EXCLUDED.role_id RETURNING *`,[id,this.endpoint,x.aiAccountId,x.roleId,x.enabled,(old?.version??0)+1,at,!!old])).rows[0];
    if(!saved)fail('operations_ai_work_assignment_changed',409);
    await db.query('UPDATE operations_ai_work_accounts_v1 SET version=version+1,authorization_version=authorization_version+1,updated_at=$3 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.aiAccountId,at]);
    result={assignment:{id:saved.id,aiAccountId:saved.ai_account_id,roleId:saved.role_id,enabled:saved.enabled,version:saved.version}};
   }else{
    if(!subset(x.targetAiAccountIds,delegation.target_ai_account_ids)||x.targetAiAccountIds.includes(current.sourceAiAccountId)||!subset(x.permissions,delegation.grantable_permissions)||!safeCeiling(x.permissions))fail('operations_ai_delegation_ceiling_denied');
    for(const id of x.targetAiAccountIds)await this.account(db,id);
    const old=x.kind==='role-update'?await this.roleWithin(db,delegation,x.id):null;if((old?.version??0)!==x.expectedVersion)fail('operations_permissions_version_changed',409);
    if(old){const assigned=(await db.query('SELECT ai_account_id FROM operations_ai_work_assignments_v1 WHERE endpoint=$1 AND role_id=$2 AND enabled',[this.endpoint,old.id])).rows;if(assigned.some(row=>!x.targetAiAccountIds.includes(row.ai_account_id)))fail('operations_ai_delegation_target_denied');}
    const id=old?.id??x.operationId,version=(old?.version??0)+1,at=new Date(this.owner.now()*1000);
    if((await db.query('SELECT 1 FROM operations_business_roles_v1 WHERE endpoint=$1 AND name=$2 AND id<>$3',[this.endpoint,x.name,id])).rows.length)fail('operations_role_name_conflict',409);
    const role=(await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,subject_scope,managed_ai_account_ids,created_by,updated_by,created_by_ai_account_id,updated_by_ai_account_id,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'ai-only',$8,$9,$9,$10,$10,$11,$11) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,enabled=EXCLUDED.enabled,version=EXCLUDED.version,permissions=EXCLUDED.permissions,managed_ai_account_ids=EXCLUDED.managed_ai_account_ids,updated_by=EXCLUDED.updated_by,updated_by_ai_account_id=EXCLUDED.updated_by_ai_account_id,updated_at=EXCLUDED.updated_at
     WHERE $12::boolean AND operations_business_roles_v1.endpoint=EXCLUDED.endpoint AND operations_business_roles_v1.subject_scope='ai-only' RETURNING *`,[id,this.endpoint,x.name,x.description,x.enabled,version,x.permissions,x.targetAiAccountIds,actor.kind==='business-operator'?actor.operatorId:null,actor.kind==='operations-ai-service'?actor.aiAccountId:null,at,!!old])).rows[0];
    if(!role)fail('operations_permissions_version_changed',409);
    result={role:roleView(role)};
   }
   await this.actorWithin(db,actor,action,{expectedDelegationVersion});await db.query('UPDATE operations_permission_authority_v1 SET version=version+1 WHERE endpoint=$1',[this.endpoint]);
   return this.record(db,actor,delegation,x.operationId,x.kind,x,result);
  });
 }
}
