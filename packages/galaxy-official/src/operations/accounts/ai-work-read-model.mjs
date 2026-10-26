import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {operationsPermissionCodes,isOperationsPermission} from '../../operations-permission-catalog.mjs';
import {operationsOperatorNamesWithin} from "./history-identities.mjs";
import {automationResourceScope} from '../../shared/operations-automation-scope.mjs';
import {aiWorkActions,aiWorkDomains,aiWorkDomainSchema,aiWorkHistorySchema,aiWorkOperationSchema,aiWorkParse,aiWorkCapabilities,aiWorkPreparation} from './ai-work-schema.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const iso=value=>value?new Date(value).toISOString():null;
export const aiWorkAccountView=row=>({id:row.id,domain:row.domain,name:row.name,description:row.description,enabled:row.enabled,version:row.version,authorizationVersion:row.authorization_version,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)});
const storedAccountView=row=>({id:row.id,domain:row.domain,name:row.name,description:row.description,enabled:row.enabled,version:row.version,authorizationVersion:row.authorizationVersion,createdAt:row.createdAt,updatedAt:row.updatedAt});
const storedAssignmentView=row=>({id:row.id,aiAccountId:row.aiAccountId,roleId:row.roleId,enabled:row.enabled,version:row.version,roleName:row.roleName,roleEnabled:row.roleEnabled,roleVersion:row.roleVersion,permissions:Array.isArray(row.permissions)?row.permissions.filter(isOperationsPermission):[]});
const safeSelection=(kind,value)=>kind==='assignment-save'?{id:value.id??null,expectedVersion:value.expectedVersion,roleId:value.roleId,enabled:value.enabled}:
 kind==='state-save'?{expectedVersion:value.expectedVersion,enabled:value.enabled}:{expectedVersion:value.expectedVersion,name:value.name,description:value.description};

/** Independent AI business identities. No OIDC principal or engine credential
 * is created here. Initialization is a separately approved migration choice. */
export class AiWorkAccountsReadModel{
 constructor({db,endpoint,businessAdmin,runtime=null,automationEditorAvailable=false,now=()=>Math.floor(Date.now()/1000)}){
  if(!db||typeof endpoint!=='string'||typeof businessAdmin?.authorizeAction!=='function')throw Error('AI work accounts require current business authorization.');
  Object.assign(this,{db,endpoint,businessAdmin,runtime,automationEditorAvailable,now});
  this.runtimeRead=null;
 }
 stamp(){const checkedAt=this.now();return{checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};}
 async actor(operator,{db=this.db,action=aiWorkActions.read}={}){
  if(operator?.kind!=='business-operator'||operator.endpoint!==this.endpoint)fail('business_admin_denied');
  return this.businessAdmin.authorizeAction(operator,action,{db});
 }
 async read(operator,operation){return transaction(this.db,async db=>{const actor=await this.actor(operator,{db}),value=await operation(db,actor);await this.actor(actor,{db});return{...value,...this.stamp()};});}
 async accountWithin(db,domain,{lock=false}={}){
  aiWorkParse(aiWorkDomainSchema,domain);const row=(await db.query('SELECT * FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2'+(lock?' FOR UPDATE':''),[this.endpoint,domain])).rows[0];
  if(!row)fail('operations_ai_work_not_initialized',409);return row;
 }
 async rolesWithin(db,actor){
  const rows=(await db.query('SELECT id,name,description,enabled,version,permissions,subject_scope FROM operations_business_roles_v1 WHERE endpoint=$1 ORDER BY name,id',[this.endpoint])).rows;
  const allowed=actor.businessAuthorization.permissions;
  return rows.map(row=>{
   const assignmentReason=!row.enabled?'role-disabled':!allowed.includes(aiWorkActions.roles)?'assignment-denied':!row.permissions.every(code=>isOperationsPermission(code)&&allowed.includes(code))?'exceeds-permissions':null;
   const {subject_scope,...role}=row;return{...role,subjectScope:subject_scope??'shared',permissions:row.permissions.filter(isOperationsPermission),canAssign:assignmentReason===null,assignmentReason};
  });
 }
 async assignmentsWithin(db,id){
  const rows=(await db.query(`SELECT a.id,a.ai_account_id,a.role_id,a.enabled,a.version,r.name AS role_name,r.enabled AS role_enabled,r.version AS role_version,r.permissions,r.subject_scope
   FROM operations_ai_work_assignments_v1 a JOIN operations_business_roles_v1 r ON r.endpoint=a.endpoint AND r.id=a.role_id
   WHERE a.endpoint=$1 AND a.ai_account_id=$2 ORDER BY r.name,a.id`,[this.endpoint,id])).rows;
  return rows.map(row=>({id:row.id,aiAccountId:row.ai_account_id,roleId:row.role_id,enabled:row.enabled,version:row.version,roleName:row.role_name,roleEnabled:row.role_enabled,roleVersion:row.role_version,subjectScope:row.subject_scope??'shared',permissions:row.permissions.filter(isOperationsPermission)}));
 }
 effective(account,assignments){
  const sources=assignments.filter(row=>row.enabled&&row.roleEnabled).map(row=>({roleId:row.roleId,roleName:row.roleName,permissions:row.permissions})),permissions=[...new Set(sources.flatMap(row=>row.permissions))].filter(code=>operationsPermissionCodes.includes(code)).sort((a,b)=>a<b?-1:a>b?1:0);
  const state=!account.enabled?'disabled':!sources.length?'unassigned':'available';
  return{state,permissions,sources,...aiWorkCapabilities(account.domain,state==='available'?permissions:[])};
 }
 capabilities(actor){const p=actor.businessAuthorization.permissions;return{canEditProfile:p.includes(aiWorkActions.profile),canChangeState:p.includes(aiWorkActions.state),canAssignRoles:p.includes(aiWorkActions.roles)};}
 async grantsWithin(db,id,actor){
  const rows=(await db.query(`SELECT id,name,enabled,version,mode,permissions,resource_scope_kind,resource_ids FROM operations_automation_grants_v1
   WHERE endpoint=$1 AND ai_account_id=$2 AND executor_kind='ai' ORDER BY created_at,id`,[this.endpoint,id])).rows;
  return{state:'available',canConfigure:this.automationEditorAvailable===true&&actor.businessAuthorization.permissions.includes('permissions.automation.write'),items:rows.map(row=>({id:row.id,name:row.name,enabled:row.enabled,version:row.version,mode:row.mode,permissions:row.permissions.filter(isOperationsPermission),resourceScope:automationResourceScope(row)}))};
 }
 async list(operator){return this.read(operator,async(db,actor)=>{
  const rows=(await db.query('SELECT * FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 ORDER BY array_position($2::text[],domain)',[this.endpoint,aiWorkDomains])).rows,items=[];
  for(const row of rows){const assignments=await this.assignmentsWithin(db,row.id),effective=this.effective(row,assignments),grants=await this.grantsWithin(db,row.id,actor);items.push({...aiWorkAccountView(row),roleNames:effective.sources.map(source=>source.roleName),permissionCount:effective.permissions.length,automationCount:grants.items.length});}
  return{items,roles:await this.rolesWithin(db,actor),initialization:{state:rows.length===5?'ready':'pending',recordedCount:rows.length,expectedCount:5}};
 });}
 async runtimeFor(domain){
  if(typeof this.runtime?.status!=='function')return{state:'not-connected',modelState:'unknown'};
  const pending=this.runtimeRead??=Promise.resolve().then(()=>this.runtime.status());
  try{
   const value=await pending;
   return{state:value?.state==='connected'?'connected':'unavailable',modelState:value?.modelState==='unknown'?'unknown':Array.isArray(value?.configuredDomains)?value.configuredDomains.includes(domain)?'configured':'not-configured':value?.modelState==='not-configured'?'not-configured':'unknown'};
  }
  catch{return{state:'unavailable',modelState:'unknown'};}
  finally{if(this.runtimeRead===pending)this.runtimeRead=null;}
 }
 async runtimeStatus(operator,domain){
  aiWorkParse(aiWorkDomainSchema,domain);
  // Check this reader before engine I/O and again before returning. No DB
  // transaction or account-role read waits for an external health request.
  await this.read(operator,db=>this.accountWithin(db,domain));
  const runtime=await this.runtimeFor(domain);
  return this.read(operator,async db=>{await this.accountWithin(db,domain);return{domain,runtime};});
 }
 async detail(operator,domain){
  aiWorkParse(aiWorkDomainSchema,domain);const actor=await this.actor(operator);
  return this.read(actor,async(db,current)=>{const row=await this.accountWithin(db,domain),assignments=await this.assignmentsWithin(db,row.id);return{
   account:aiWorkAccountView(row),assignments,roles:await this.rolesWithin(db,current),effective:this.effective(row,assignments),capabilities:this.capabilities(current),automation:await this.grantsWithin(db,row.id,current),
   humanUse:{permission:'ai.use.'+domain,source:'business-roles',rootIncludesAll:true,directoryHref:current.businessAuthorization.permissions.includes('management.accounts.read')?'/admin/operations/management-accounts?aiDomain='+domain:null},
   runtime:{state:'pending',modelState:'unknown'},history:await this.historyWithin(db,domain),
  };});
 }
 receipt(row,replayed=false){
  if(!row.result?.account)fail('operations_ai_work_receipt_unavailable',503);
  return{state:'recorded',operationId:row.operation_id,kind:row.kind,domain:row.domain,selection:safeSelection(row.kind,row.selection),result:{account:storedAccountView(row.result.account),...(row.kind==='assignment-save'&&row.result.assignment?{assignment:storedAssignmentView(row.result.assignment)}:{})},recordedAt:iso(row.created_at),replayed};
 }
 operation(operator,id){aiWorkParse(aiWorkOperationSchema,id);return this.read(operator,async(db,actor)=>{
  const row=(await db.query('SELECT operation_id,operator_id,kind,domain,selection,result,created_at FROM operations_ai_work_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0];
  if(!row)return{state:'not-recorded',operationId:id,kind:null,domain:null,selection:null,result:null,recordedAt:null,replayed:false};
  if(row.operator_id!==actor.operatorId)fail('operations_ai_work_operation_not_found',404);return this.receipt(row,true);
 });}
 async historyWithin(db,domain,input={}){
  const q=aiWorkParse(aiWorkHistorySchema,input),rows=(await db.query(`SELECT operation_id,operator_id,kind,domain,selection,result,reason,created_at,sequence
   FROM operations_ai_work_commands_v1 WHERE endpoint=$1 AND domain=$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4`,[this.endpoint,domain,q.after??null,q.limit+1])).rows;
  const names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:rows.map(row=>row.operator_id)});
  return{items:rows.slice(0,q.limit).map(row=>({...this.receipt(row),sequence:String(row.sequence),operatorId:row.operator_id,operatorDisplayName:names.get(row.operator_id)??null,reason:row.reason||null})),nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null};
 }
 history(operator,domain,input={}){aiWorkParse(aiWorkDomainSchema,domain);return this.read(operator,async db=>{await this.accountWithin(db,domain);return this.historyWithin(db,domain,input);});}
 /** Trusted runtime read with the worker's narrow columns. Never an HTTP
  * identity resolver and never a replacement for the task/grant authority. */
 async authorizationWithin(db,domain,{accountId=null}={}){
  aiWorkParse(aiWorkDomainSchema,domain);await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))',[this.endpoint]);
  const account=(await db.query('SELECT id,domain,enabled,authorization_version FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND domain=$2',[this.endpoint,domain])).rows[0];
  if(!account||accountId!==null&&account.id!==accountId)fail('operations_ai_work_not_initialized',409);
  const rows=(await db.query(`SELECT a.id,a.version,a.role_id,r.version AS role_version,r.permissions FROM operations_ai_work_assignments_v1 a
   JOIN operations_business_roles_v1 r ON r.endpoint=a.endpoint AND r.id=a.role_id WHERE a.endpoint=$1 AND a.ai_account_id=$2 AND a.enabled AND r.enabled ORDER BY a.id`,[this.endpoint,account.id])).rows;
  return{accountId:account.id,domain,enabled:account.enabled,authorizationVersion:account.authorization_version,permissions:[...new Set(rows.flatMap(row=>row.permissions))].filter(isOperationsPermission).sort((a,b)=>a<b?-1:a>b?1:0),roleVersions:rows.map(row=>({assignmentId:row.id,assignmentVersion:row.version,roleId:row.role_id,roleVersion:row.role_version}))};
 }
 async executionRoleWithin(db,{domain,aiAccountId,actions}){
  if(!aiWorkOperationSchema.safeParse(aiAccountId).success)fail('operations_ai_work_unassigned');
  const current=await this.authorizationWithin(db,domain,{accountId:aiAccountId}),capabilities=aiWorkCapabilities(domain,current.enabled?current.permissions:[]);
  if(!Array.isArray(actions)||!current.enabled||actions.some(action=>!capabilities.autonomousPermissions.includes(action)))fail('operations_ai_work_permission_denied');
  return current;
 }
 async assertEnabledWithin(db,domain){const current=await this.authorizationWithin(db,domain);if(!current.enabled)fail('operations_ai_work_disabled');return current;}
 /** No human authorization call here: transaction-level consumers have
  * already checked the real human and can enforce the AI half without
  * recursively entering BusinessAdmin/permissions again. */
 async assertRoleWithin(db,domain,action,{purpose='query'}={}){
  const current=await this.assertEnabledWithin(db,domain),capabilities=aiWorkCapabilities(domain,current.permissions);
  const usable=purpose==='query'?capabilities.queryPermissions.includes(action):purpose==='execution'?capabilities.autonomousPermissions.includes(action):purpose==='prepare'&&aiWorkPreparation.some(entry=>capabilities.preparableKinds.includes(entry.kind)&&(entry.read===action||entry.actions.includes(action)));
  if(!current.permissions.includes(action)||!usable)fail('operations_ai_work_permission_denied');
  return{accountId:current.accountId,domain,authorizationVersion:current.authorizationVersion,roleVersions:current.roleVersions,permission:action};
 }
 async assertEnabled(operator,domain,{db=this.db}={}){
  if(db===this.db)return transaction(db,tx=>this.assertEnabled(operator,domain,{db:tx}));
  aiWorkParse(aiWorkDomainSchema,domain);let actor=await this.actor(operator,{db,action:'workbench.read'});actor=await this.actor(actor,{db,action:'ai.use.'+domain});
  const current=await this.assertEnabledWithin(db,domain);
  return{actor,...current};
 }
 /** Internal current-role check only. It never mints or impersonates a human
  * or executor, and must surround the real domain service/source checks. */
 async assertRolePermission(operator,domain,action,{db=this.db,purpose='query'}={}){
  if(db===this.db)return transaction(db,tx=>this.assertRolePermission(operator,domain,action,{db:tx,purpose}));
  const current=await this.assertEnabled(operator,domain,{db}),actor=await this.actor(current.actor,{db,action}),role=await this.assertRoleWithin(db,domain,action,{purpose});
  return{actor,...role};
 }
}
