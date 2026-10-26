import {transaction} from "../../infrastructure/database.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {operationsPermissionCodes} from '../../operations-permission-catalog.mjs';
import {isOperationsRootPrincipal} from "./root-principal.mjs";
import {requiresManagementMaintainer} from '../../shared/operations-management-maintainer-actions.mjs';
import {ManagementDirectory} from './management-directory.mjs';
import {managementParse as parse,managementListSchema,managementHistorySchema,managementOperatorIdSchema,managementPhaseKinds,managementPhaseStates,
 managementCodes,managementId,managementDisplay,managementStamp,managementTargetVersion} from './management-schema.mjs';

const fail=(code,status=403)=>{throw new ServiceError(code,status);};
const capabilityActions=Object.freeze({canEditProfile:'management.accounts.profile.write',canDisableLogin:'management.accounts.login.disable',
 canRestoreLogin:'management.accounts.login.restore',canResetPassword:'management.accounts.password.reset',canRevokeSessions:'management.accounts.sessions.revoke',
 canDelete:'management.accounts.delete',canAssignRoles:'permissions.assignments.write',canChangeEmail:'management.accounts.profile.write'});
const rowIdentity=row=>({issuer:row.issuer,externalSubject:row.external_subject,username:row.username??'',firstName:row.first_name??'',lastName:row.last_name??'',
 email:row.email??null,emailVerified:row.email_verified??null,enabled:row.enabled??null,createdAt:managementStamp(row.native_created_at??row.created_at),
 admission:row.admission??'none',requiredActions:row.required_actions??[]});
const count=value=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('management_directory_source_changed',503);return n;};

// Complete-generation list facts are observations. Sensitive detail and every
// command return to the current configured realm and current PG authority.
export class ManagementAccountsReadModel{
 constructor({businessAdmin,directory=null,rootPrincipal=null,managementSessions=null,db=businessAdmin?.db,endpoint=businessAdmin?.endpoint,
  now=businessAdmin?.now??(()=>Math.floor(Date.now()/1000))}){
  if(!businessAdmin||!db||typeof endpoint!=='string')throw Error('Management accounts require the current business authorizer.');
  if(rootPrincipal&&(!isOperationsRootPrincipal(rootPrincipal,rootPrincipal)||rootPrincipal.endpoint!==endpoint||directory&&rootPrincipal.issuer!==directory.issuer))throw Error('Invalid management root identity.');
  Object.assign(this,{businessAdmin,directory,rootPrincipal,managementSessions,db,endpoint,now});this.index=new ManagementDirectory({db,endpoint,directory,now});
 }
 stamp(){const checkedAt=this.now();return {checkedAt,readExpiresAt:checkedAt+30,metadataOnly:true};}
 async actor(operator,{db=this.db,action='management.accounts.read'}={}){
  if(operator?.kind!=='business-operator')fail('business_admin_denied');return this.businessAdmin.authorizeAction(operator,action,{db});
 }
 async read(operator,operation){return transaction(this.db,async db=>{const actor=await this.actor(operator,{db});const result=await operation(db,actor);
  await this.actor(actor,{db});return {...result,...this.stamp()};});}
 sync(){return this.index.sync();}
 rootActor(actor){return actor?.role==='administrator'&&actor?.operatorId===this.rootPrincipal?.operatorId;}
 rootTarget(user){return !!this.rootPrincipal&&isOperationsRootPrincipal(this.rootPrincipal,user);}
 has(actor,action){return actor.businessAuthorization.permissions.includes(action);}
 async roleFacts(db,id){
  const rows=(await db.query(`SELECT a.id AS assignment_id,a.version AS assignment_version,a.enabled AS assignment_enabled,r.id,r.name,r.description,r.version,r.enabled,r.permissions
   FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.endpoint=a.endpoint AND r.id=a.role_id
   WHERE a.endpoint=$1 AND a.operator_id=$2 ORDER BY r.name,r.id`,[this.endpoint,id])).rows;
  return rows.map(row=>({id:row.id,name:row.name,description:row.description,version:row.version,enabled:row.enabled,permissions:row.permissions.filter(v=>operationsPermissionCodes.includes(v)),
   assignmentId:row.assignment_id,assignmentVersion:row.assignment_version,assignmentEnabled:row.assignment_enabled}));
 }
 async roleCatalog(db,actor){const rows=(await db.query('SELECT id,name,description,enabled,version,permissions FROM operations_business_roles_v1 WHERE endpoint=$1 ORDER BY name,id',[this.endpoint])).rows;
  return rows.map(role=>({...role,permissions:role.permissions.filter(v=>operationsPermissionCodes.includes(v)),
   canAssign:role.enabled&&this.has(actor,'permissions.assignments.write')&&role.permissions.every(code=>this.has(actor,code))}));
 }
 effective(user,meta,roles){
  const eligible=!!user?.enabled&&user.admission!=='none'&&!meta?.login_blocked&&!meta?.deleted_at;
  const root=this.rootTarget(user),sources=eligible?(root?[{kind:'preconfigured-root',roleId:null,label:'预配置根管理员',permissions:[...operationsPermissionCodes]}]:roles
   .filter(row=>row.enabled&&row.assignmentEnabled).map(row=>({kind:'business-role',roleId:row.id,label:row.name,
    permissions:row.permissions.filter(code=>user.admission==='administrator'||!requiresManagementMaintainer(code))}))):[];
  return {state:eligible?'available':'not-eligible',permissions:[...new Set(sources.flatMap(row=>row.permissions))].sort((a,b)=>a<b?-1:a>b?1:0),sources};
 }
 aiUse(effective,root){return {domains:['overview','governance','messaging','discovery','maintenance'].filter(domain=>effective.permissions.includes('ai.use.'+domain)),
  source:root?'preconfigured-root':'business-roles'};}
 item(row,{identity=null,roles=[]}={}){
  const user=identity??rowIdentity(row),root=this.rootTarget(user),effective=this.effective(user,row,roles);
  return {operatorId:row.operator_id??managementId(user.issuer,user.externalSubject),displayName:managementDisplay(user),username:user.username||null,email:user.email??null,
   emailVerified:user.emailVerified??null,enabled:typeof user.enabled==='boolean'?user.enabled&&!row.login_blocked&&!row.deleted_at:null,
   nativeEnabled:user.enabled??null,loginBlocked:row.login_blocked??false,createdAt:user.createdAt??null,admission:user.admission,rootAdministrator:root,
   lifecycle:row.deleted_at?'deleted':'present',deletedAt:managementStamp(row.deleted_at),businessRoles:roles,aiUse:this.aiUse(effective,root)};
 }
 capabilities(actor,user,meta,{emailAvailable=false}={}){
  const current=!!user&&!meta?.deleted_at,root=this.rootTarget(user),self=actor.operatorId===managementId(user?.issuer??'',user?.externalSubject??''),writer=!!this.directory?.managementConfigured,
   allowed=current&&!!this.rootPrincipal&&(!root||self&&this.rootActor(actor));
  const caps=Object.fromEntries(Object.entries(capabilityActions).map(([key,code])=>[key,allowed&&this.has(actor,code)]));
  caps.canEditProfile&&=writer;caps.canResetPassword&&=writer;caps.canDisableLogin&&=writer&&!root&&!self&&user.enabled===true&&!meta?.login_blocked;
  caps.canRestoreLogin&&=writer&&!root&&(user.enabled===false||meta?.login_blocked===true);caps.canDelete&&=writer&&!root&&!self;
  caps.canAssignRoles&&=!root&&user.admission!=='none'&&user.enabled===true&&!meta?.login_blocked;
  caps.canRevokeSessions&&=writer&&typeof this.managementSessions?.revoke==='function';
  caps.canChangeEmail&&=writer&&emailAvailable;
  caps.canChangeAdmission=allowed&&writer&&!root&&this.rootActor(actor);
  return caps;
 }
 list(operator,input={}){const x=parse(managementListSchema,input);return this.read(operator,async(db,actor)=>{
  const source=await this.index.source(db),roles=await this.roleCatalog(db,actor),capabilities={canCreate:!!this.rootPrincipal&&!!this.directory?.managementConfigured&&this.has(actor,'management.accounts.create')},
   pagination={page:x.page,pageSize:x.pageSize,total:null,matchingTotal:null,totalPages:null};
  if(!source.generationId)return {items:[],source,pagination,capabilities,roles};
  const values=[this.endpoint,source.generationId],where=[];const arg=value=>{values.push(value);return '$'+values.length;};
  const joins=` FROM operations_management_entries_v1 e LEFT JOIN operations_management_accounts_v1 m ON m.endpoint=$1 AND m.operator_id=e.operator_id
   WHERE e.generation_id=$2 AND m.deleted_at IS NULL`;
  if(x.query){const value=arg(x.query);where.push(`(e.username ILIKE '%'||${value}||'%' OR concat_ws(' ',e.first_name,e.last_name) ILIKE '%'||${value}||'%' OR e.email ILIKE '%'||${value}||'%')`);}
  if(x.enabled)where.push(`(e.enabled AND NOT COALESCE(m.login_blocked,false))=${arg(x.enabled==='true')}`);
  if(x.roleId)where.push(`EXISTS(SELECT 1 FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint
   WHERE a.endpoint=$1 AND a.operator_id=e.operator_id AND a.enabled AND r.enabled AND r.id=${arg(x.roleId)})`);
  if(x.aiDomain){const code=arg('ai.use.'+x.aiDomain),rootId=arg(this.rootPrincipal?.operatorId??'');where.push(`e.enabled AND NOT COALESCE(m.login_blocked,false) AND e.admission<>'none' AND
   (e.operator_id=${rootId} OR EXISTS(SELECT 1 FROM operations_role_assignments_v1 a JOIN operations_business_roles_v1 r ON r.id=a.role_id AND r.endpoint=a.endpoint
   WHERE a.endpoint=$1 AND a.operator_id=e.operator_id AND a.enabled AND r.enabled AND ${code}=ANY(r.permissions)))`);}
  const filtered=where.length?' AND '+where.join(' AND '):'',total=count((await db.query('SELECT count(*)::text AS n'+joins,values.slice(0,2))).rows[0].n),
   matching=count((await db.query('SELECT count(*)::text AS n'+joins+filtered,values)).rows[0].n);
  const limit=arg(x.pageSize),offset=arg((x.page-1)*x.pageSize),order=x.sort==='name-asc'?'lower(concat_ws(\' \',NULLIF(e.first_name,\'\'),NULLIF(e.last_name,\'\'),e.username)) ASC':
   `e.created_at ${x.sort==='created-asc'?'ASC':'DESC'} NULLS LAST`;
  const rows=(await db.query('SELECT e.*,m.version,m.login_blocked,m.deleted_at'+joins+filtered+` ORDER BY ${order},e.operator_id LIMIT ${limit} OFFSET ${offset}`,values)).rows;
  const items=[];for(const row of rows)items.push(this.item(row,{roles:await this.roleFacts(db,row.operator_id)}));
  return {items,source,pagination:{...pagination,total,matchingTotal:matching,totalPages:Math.ceil(matching/x.pageSize)},capabilities,roles};
 });}
 async targetWithin(db,id){parse(managementOperatorIdSchema,id);
  const row=(await db.query(`SELECT COALESCE(e.operator_id,m.operator_id,p.operator_id) AS operator_id,COALESCE(e.issuer,m.issuer,p.issuer) AS issuer,
   COALESCE(e.external_subject,m.external_subject,p.external_subject) AS external_subject,e.username,e.first_name,e.last_name,e.email,e.email_verified,e.enabled,e.admission,e.required_actions,
   e.created_at AS native_created_at,m.version,m.note,m.login_blocked,m.deleted_at,p.display_name AS principal_display_name
   FROM operations_operator_principals_v1 p FULL JOIN operations_management_accounts_v1 m ON m.operator_id=p.operator_id AND m.endpoint=p.endpoint
   FULL JOIN operations_management_entries_v1 e ON e.operator_id=COALESCE(p.operator_id,m.operator_id) AND e.generation_id=(SELECT generation_id FROM operations_management_directory_v1 WHERE endpoint=$1)
   WHERE COALESCE(p.endpoint,m.endpoint,$1)=$1 AND COALESCE(e.operator_id,m.operator_id,p.operator_id)=$2`,[this.endpoint,id])).rows[0];
  if(!row||this.directory&&row.issuer!==this.directory.issuer)fail('management_identity_not_found',404);return row;
 }
 async native(row){if(!this.directory)return {state:'not-configured',identity:null};
  try{const identity=await this.directory.get({issuer:row.issuer,externalSubject:row.external_subject});
   if(identity&&(identity.issuer!==row.issuer||identity.externalSubject!==row.external_subject))fail('management_identity_response_invalid',503);
   return {state:identity?'available':'not-found',identity};}catch{return {state:'unavailable',identity:null};}
 }
 safeResult(value){const phases=[];
  for(const row of Array.isArray(value?.phases)?value.phases:[]){if(!managementPhaseKinds.includes(row?.kind)||!managementPhaseStates.includes(row?.state))continue;
   phases.push({kind:row.kind,state:row.state,code:managementCodes.includes(row.code)?row.code:null,
    ...(Number.isSafeInteger(row.revokedSessions)&&row.revokedSessions>=0?{revokedSessions:row.revokedSessions}:{}),...(row.inflightBlocked===true?{inflightBlocked:true}:{})});}
  return {phases,revision:Number.isSafeInteger(value?.revision)&&value.revision>0?value.revision:null};
 }
 receipt(row,replayed=false){return {operationId:row.operation_id,targetOperatorId:row.target_operator_id,kind:row.kind,state:row.state,
  result:this.safeResult(row.result),recordedAt:managementStamp(row.created_at),replayed};}
 async historyWithin(db,id,input={}){const x=parse(managementHistorySchema,input),rows=(await db.query(`SELECT c.*,p.display_name AS operator_display_name
  FROM operations_management_commands_v1 c LEFT JOIN operations_operator_principals_v1 p ON p.endpoint=c.endpoint AND p.operator_id=c.operator_id
  WHERE c.endpoint=$1 AND c.target_operator_id=$2 AND ($3::bigint IS NULL OR c.sequence<$3) ORDER BY c.sequence DESC LIMIT $4`,[this.endpoint,id,x.after??null,x.limit+1])).rows;
  return {items:rows.slice(0,x.limit).map(row=>({...this.receipt(row),sequence:String(row.sequence),operatorId:row.operator_id,
   operatorDisplayName:typeof row.operator_display_name==='string'&&row.operator_display_name.length<=240?row.operator_display_name:null,
   reason:typeof row.input?.reason==='string'&&row.input.reason.length<=1000?row.input.reason:null,updatedAt:managementStamp(row.updated_at)})),nextAfter:rows.length>x.limit?String(rows[x.limit-1].sequence):null};}
 history(operator,id,input={}){return this.read(operator,async db=>{await this.targetWithin(db,id);return this.historyWithin(db,id,input);});}
 async detail(operator,id){const initial=await this.actor(operator),row=await this.targetWithin(this.db,id),native=await this.native(row),user=native.identity;
  const sessions={sso:{state:'unavailable',activeCount:null,scope:'keycloak-management-sso'},portal:{state:'unavailable',activeCount:null,scope:'management-portal'}};
  if(user){try{sessions.sso=await this.directory.sessions(user);}catch{/* Missing native read access is not zero sessions. */}
   if(typeof this.managementSessions?.summary==='function')try{const found=await this.managementSessions.summary({operatorId:id,issuer:user.issuer,externalSubject:user.externalSubject});
    if(Number.isSafeInteger(found?.activeCount)&&found.activeCount>=0)sessions.portal={state:'available',activeCount:found.activeCount,scope:'management-portal'};}catch{/* No session token is read or exposed. */}}
  const emailAvailable=!!user&&typeof this.directory?.emailChangeAvailability==='function'&&await this.directory.emailChangeAvailability()===true;
  return this.read(initial,async(db,actor)=>{const current=await this.targetWithin(db,id),roles=await this.roleFacts(db,id),effective=this.effective(user,current,roles),root=this.rootTarget(user??current);
   return {item:this.item(current,{identity:user??{issuer:current.issuer,externalSubject:current.external_subject,username:current.username??current.principal_display_name??'',
     firstName:'',lastName:'',email:null,emailVerified:null,enabled:null,createdAt:managementStamp(current.native_created_at),admission:null,requiredActions:[]},roles}),
    identity:{state:native.state,issuer:current.issuer,externalSubject:current.external_subject,firstName:user?.firstName??null,lastName:user?.lastName??null,requiredActions:user?.requiredActions??[]},
    profile:{note:current.note??'',revision:current.version??0},targetVersion:managementTargetVersion(user,current),versionBasis:'observed-current-source',effective,aiUse:this.aiUse(effective,root),
    roles:await this.roleCatalog(db,actor),
    capabilities:this.capabilities(actor,user,current,{emailAvailable}),security:{identityManagement:this.directory?.managementConfigured?'configured':'not-configured',sessions},history:await this.historyWithin(db,id)};
  });
 }
 operation(operator,id){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))fail('invalid_management_accounts_request',400);
  return this.read(operator,async(db,actor)=>{const row=(await db.query('SELECT * FROM operations_management_commands_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,id])).rows[0];
   if(!row)return {state:'not-recorded',operationId:id,targetOperatorId:null,kind:null,result:null,recordedAt:null,replayed:false};
   if(row.operator_id!==actor.operatorId)fail('management_operation_not_found',404);return this.receipt(row,true);
  });}
}
