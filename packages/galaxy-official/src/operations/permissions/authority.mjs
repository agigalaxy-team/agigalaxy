import {createHash} from 'node:crypto';
import {transaction} from "../../database.mjs";
import {operationsPermissionCatalog,operationsPermissionCodes,isOperationsPermission} from "../../operations-permission-catalog.mjs";
import {fail,identity} from './helpers.mjs';
import {automationResourceScope,automationEligibleActions,automationResourceIdsSchema} from '../../shared/operations-automation-scope.mjs';
import {operationsAiUseDomain,operationsAiUseAllowed,operationsAiUsePermission,operationsAiWorkAuthorizationWithin,inheritOperationsAiUse} from '../../shared/operations-ai-use.mjs';
import {requiresManagementMaintainer} from '../../shared/operations-management-maintainer-actions.mjs';

// Verified management eligibility and current committed PG authority; no caller role or cached permission snapshot is trusted.
export class OperationsPermissionsAuthority{
 constructor({db,endpoint,operatorAuthorization=null,managementMaintainerAuthorization=null,runtimeStatus=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,operatorAuthorization,managementMaintainerAuthorization,runtimeStatus,now});}
 async effective(operator,options={}){
  if(operator?.kind==='operations-ai-service'){
   if(!this.aiServiceAuthority?.acceptsDuty(operator))fail('business_admin_denied');
   const actor=await this.aiServiceAuthority.requireDutyAction(operator,'workbench.read',{db:options.db??this.db});
   return{...actor.businessAuthorization,role:null,source:'ai-business-roles'};
  }
  const aiDomain=operationsAiUseDomain(operator);
  if(!options.db||options.db===this.db)return transaction(this.db,db=>this.effective(operator,{db,...(options.includeManagementEligibility===true?{includeManagementEligibility:true}:{})}));
  const {db}=options;
  const actor=identity(operator,this.endpoint);
  if(!(await db.query('SELECT 1 FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2',[actor.operatorId,this.endpoint])).rows.length)fail('business_admin_denied');
  if(typeof this.operatorAuthorization!=='function')fail('operations_authorization_unavailable',503);
  // Deliberately discard role/capabilities supplied by a caller.
  const role=await this.operatorAuthorization({...actor,role:'reader'},{db});
  if(!['administrator','reader'].includes(role))fail('business_admin_denied');
  // Shared advisory locking keeps the version and grant rows in one committed
  // authority state without requiring UPDATE privileges for read-only workers.
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))',[this.endpoint]);
  const authority=(await db.query('SELECT version FROM operations_permission_authority_v1 WHERE endpoint=$1',[this.endpoint])).rows[0];
  let permissions;
  if(role==='administrator')permissions=[...operationsPermissionCodes];
  else permissions=(await db.query(`SELECT DISTINCT unnest(r.permissions) AS permission FROM operations_role_assignments_v1 a
   JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint
   WHERE a.endpoint=$1 AND a.operator_id=$2 AND a.enabled AND r.enabled`,[this.endpoint,actor.operatorId])).rows.map(row=>row.permission).filter(isOperationsPermission).sort();
  let managementEligibility=role==='administrator'?'qualified':'unknown';
  const requiresQualification=role!=='administrator'&&permissions.some(requiresManagementMaintainer);
  if(role!=='administrator'&&(requiresQualification||options.includeManagementEligibility===true)){
   let qualified=null;
   try{if(typeof this.managementMaintainerAuthorization==='function')qualified=await this.managementMaintainerAuthorization(actor,{db});}
   catch(error){if(requiresQualification)throw error;}
   managementEligibility=qualified===true?'qualified':qualified===false?'unqualified':'unknown';
   if(requiresQualification&&qualified!==true)permissions=permissions.filter(code=>!requiresManagementMaintainer(code));
  }
  if(aiDomain&&!operationsAiUseAllowed(permissions,aiDomain))fail('operations_agentos_ai_use_denied');
  let version=String(authority?.version??0);
  const work=await operationsAiWorkAuthorizationWithin(operator,db);
  if(work){
   // Human entry permissions are not business authority for the position. Even
   // a root caller must intersect business data/actions with its current roles.
   const controls=['workbench.read',operationsAiUsePermission(aiDomain)];
   permissions=permissions.filter(code=>controls.includes(code)||work.permissions.includes(code));
   // Global revisions also change for unrelated program grants. A work
   // conversation follows this person's actual assignments and this position,
   // not every authority edit on the website. Keep related row versions so a
   // revoke/regrant cannot revive an older conversation even with equal rights.
   const humanRoles=role==='administrator'?[]:(await db.query(`SELECT a.id,a.version,a.enabled,r.id AS role_id,r.version AS role_version,r.enabled AS role_enabled
    FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint
    WHERE a.endpoint=$1 AND a.operator_id=$2 AND a.enabled ORDER BY a.id`,[this.endpoint,actor.operatorId])).rows;
   const humanScope={endpoint:this.endpoint,operatorId:actor.operatorId,role,roles:humanRoles.map(row=>[row.id,row.version,row.enabled,row.role_id,row.role_version,row.role_enabled])};
   version='ai-work:'+createHash('sha256').update(JSON.stringify([humanScope,work.accountId,work.authorizationVersion,work.roleVersions,work.purpose,permissions])).digest('hex');
  }
  return {version,permissions,source:role==='administrator'?'preconfigured-root':'business-roles',role,...(options.includeManagementEligibility===true?{managementEligibility}:{})};
 }
 async requireAction(operator,action,{db=this.db}={}){
  if(operator?.kind==='operations-ai-service'){
   if(!this.aiServiceAuthority?.acceptsDuty(operator))fail('business_admin_denied');return this.aiServiceAuthority.requireDutyAction(operator,action,{db});
  }
  if(db===this.db)return transaction(this.db,tx=>this.requireAction(operator,action,{db:tx}));
  if(!isOperationsPermission(action))fail('operations_permission_unknown');
  const actor=identity(operator,this.endpoint),effective=await this.effective(operator,{db});
  if(!effective.permissions.includes(action))fail('operations_permission_denied');
  return inheritOperationsAiUse(operator,{...actor,role:effective.role,businessAuthorization:{version:effective.version,permissions:effective.permissions}});
 }
 // A server-attested task may inspect the intersection. This is not an engine
 // credential or an execution endpoint; unconnected grants cannot run jobs.
 async executionIntersection({grantId,person=null,actions,resourceIds=[]},{db=this.db}={}){
  if(db===this.db)return transaction(db,tx=>this.executionIntersection({grantId,person,actions,resourceIds},{db:tx}));
  const grant=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,grantId])).rows[0];
  if(!grant?.enabled)fail('operations_automation_denied');
  if(!Array.isArray(actions)||actions.some(action=>!isOperationsPermission(action)))fail('operations_permission_unknown');
  const scope=automationResourceScope(grant);
  if(scope.kind==='unresolved'||!automationResourceIdsSchema.safeParse(resourceIds).success||actions.length&&!resourceIds.length||scope.kind==='selected'&&resourceIds.some(id=>!scope.resourceIds.includes(id)))fail('operations_automation_scope_denied');
  if(scope.kind==='eligible'&&actions.some(action=>!automationEligibleActions.includes(action)))fail('operations_automation_scope_denied');
  let allowed=grant.permissions;
  if(grant.mode==='assisted'){if(!person)fail('operations_automation_person_required');const effective=await this.effective(person,{db});allowed=allowed.filter(code=>effective.permissions.includes(code));}
  allowed=allowed.filter(code=>actions.includes(code)&&!operationsPermissionCatalog.find(item=>item.code===code)?.humanOnly);
  // This query reports a permission intersection only. Eligible objects still
  // require the runtime's server-side qualification and a frozen execution.
  return {permissions:allowed,executionAvailable:false,state:'not-connected',grantVersion:grant.version,resourceScope:scope};
 }
}
export async function requireOperationsActionWithin(db,{permissions,actor,action}){if(!permissions)fail('operations_authorization_unavailable',503);return permissions.requireAction(actor,action,{db});}
