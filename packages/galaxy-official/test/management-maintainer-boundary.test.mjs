import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from "../src/infrastructure/database.mjs";
import {migrations} from '../src/infrastructure/migrations.mjs';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsManagementAccountsService} from '../src/operations/accounts/management-service.mjs';
import {createStoredOperatorAuthorization,createStoredManagementMaintainerAuthorization} from "../src/operations/configuration.mjs";
import {createOperationsManagementSessions} from "../src/operations/accounts/management-sessions.mjs";
import {managementMaintainerPermissionCodes} from '../src/shared/operations-management-maintainer-actions.mjs';
import {managementId} from '../src/operations/accounts/management-schema.mjs';

const endpoint='https://management-maintainer.example.invalid';
const issuer='https://identity.example.invalid/realms/galaxy-operations';
const nativeRoles={administrator:'synthetic-management-administrator',reader:'synthetic-management-reader'};
const expectedCodes=[
 'management.accounts.create','management.accounts.profile.write','management.accounts.login.disable','management.accounts.login.restore',
 'management.accounts.password.reset','management.accounts.sessions.revoke','management.accounts.delete','permissions.assignments.write',
];
const readable=['management.accounts.read','permissions.read','content.read'];
const denied=code=>error=>error?.code===code&&error.status===403;
const writeCaps=['canEditProfile','canDisableLogin','canRestoreLogin','canResetPassword','canRevokeSessions','canDelete','canAssignRoles','canChangeEmail','canChangeAdmission'];

// Actual current PGlite including the management122 boundary, SQL roles and immutable-principal lookup,
// local active gate, permission/service/read-model and command transactions.
// Native role-directory and management-directory I/O are explicit doubles.
// No browser/HTTP/SMTP/provider or held120 is involved.
test('management maintenance intersects immutable principal, current native admission and role; ordinary grants and forged actor roles cannot bypass the boundary',
 {timeout:90000},async t=>{
  assert.equal(migrations.some(row=>row.version===122),true);
  assert.equal(migrations.some(row=>row.version===120),false);
  assert.deepEqual([...managementMaintainerPermissionCodes],expectedCodes);
  const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
  const now=()=>Math.floor(Date.now()/1000),at=()=>new Date(now()*1000).toISOString();
  const people=[
   {externalSubject:'synthetic-fixed-root',username:'synthetic-root',firstName:'Synthetic Root',admission:'administrator'},
   {externalSubject:'synthetic-ordinary',username:'synthetic-ordinary',firstName:'Synthetic Ordinary',admission:'reader'},
   {externalSubject:'synthetic-promoted',username:'synthetic-promoted',firstName:'Synthetic Promoted',admission:'administrator'},
  ].map(person=>({...person,issuer,lastName:'',email:null,emailVerified:false,enabled:true,requiredActions:[],createdAt:at()}));
  const live=new Map(people.map(person=>[person.externalSubject,person]));
  // Deliberately remains cached after a native demotion: only directory.get
  // provides the fresh maintenance qualification.
  const cachedNames=new Map(people.map(person=>[person.externalSubject,[nativeRoles[person.admission]]]));
  const reads=[],unexpectedEffects=[];
  const roleDirectory={
   async getOperatorRoles(principal){assert.equal(principal.issuer,issuer);return [...cachedNames.get(principal.externalSubject)??[]];},
   invalidateOperatorRoles(principal){return principal.issuer===issuer;},
  };
  const directory={
   issuer,managementConfigured:true,emailChangeConfigured:false,
   async get(principal){assert.equal(principal.issuer,issuer);reads.push(principal.externalSubject);const user=live.get(principal.externalSubject);return user?structuredClone(user):null;},
   async sessions(){return {state:'available',activeCount:0,scope:'keycloak-management-sso'};},
   async emailChangeAvailability(){return false;},
   async profile(){unexpectedEffects.push('native-profile');throw Error('No native profile write belongs to this boundary leaf');},
  };
  const principal=person=>({operatorId:managementId(issuer,person.externalSubject),issuer,externalSubject:person.externalSubject});
  const rootPrincipal={version:1,endpoint,...principal(people[0])};
  const actor=person=>({kind:'business-operator',endpoint,operatorId:principal(person).operatorId,role:'reader'});
  const [root,ordinary,promoted]=people.map(actor);
  for(const person of people){
   const p=principal(person);
   await db.query('INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
    [p.operatorId,endpoint,issuer,p.externalSubject,person.firstName,at()]);
   await db.query('INSERT INTO operations_management_accounts_v1(operator_id,endpoint,issuer,external_subject,version,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$6)',
    [p.operatorId,endpoint,issuer,p.externalSubject,root.operatorId,at()]);
  }
  const roles={read:randomUUID(),all:randomUUID(),spare:randomUUID()};
  const permissionsByRole={read:readable,all:[...readable,...expectedCodes],spare:['content.read']};
  for(const[key,id]of Object.entries(roles))await db.query(
   'INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$6,$6,$7,$7)',
   [id,endpoint,'Synthetic '+key,'Bounded local fixture only',permissionsByRole[key],root.operatorId,at()]);
  for(const[who,key]of[[ordinary,'all'],[promoted,'read']])await db.query(
   'INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$5,$6,$6)',
   [randomUUID(),endpoint,who.operatorId,roles[key],root.operatorId,at()]);
  const sessions=createOperationsManagementSessions({db,endpoint,issuer,roleDirectory,now});
  const stored=createStoredOperatorAuthorization({db,endpoint,issuer,roles:nativeRoles,roleDirectory,rootPrincipal,managementSessions:sessions});
  const maintainer=createStoredManagementMaintainerAuthorization({db,endpoint,issuer,rootPrincipal,managementDirectory:directory,managementSessions:sessions});
  const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:stored,managementMaintainerAuthorization:maintainer,now});
  const businessAdmin=new BusinessAdminService({db,endpoint,permissions,now});
  const service=new OperationsManagementAccountsService({businessAdmin,directory,rootPrincipal,managementSessions:sessions,now});
  const as=who=>({authorize:async()=>({...who})});
  await db.exec('SET ROLE galaxy_api');
  assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');

  // An accidentally assigned business role is not maintenance admission.
  const ordinaryEffective=await permissions.effective(ordinary);
  assert.equal(ordinaryEffective.role,'reader');assert.equal(ordinaryEffective.source,'business-roles');
  assert.deepEqual(ordinaryEffective.permissions,[...readable].sort());
  for(const code of expectedCodes)await assert.rejects(permissions.requireAction(ordinary,code),denied('operations_permission_denied'));
  assert.equal(await maintainer(ordinary),false);
  const ordinaryDetail=await service.detail(ordinary,ordinary.operatorId);
  for(const cap of writeCaps)assert.equal(ordinaryDetail.capabilities[cap],false,cap);
  assert(expectedCodes.every(code=>!ordinaryDetail.effective.permissions.includes(code)));
  assert(ordinaryDetail.effective.sources.every(source=>expectedCodes.every(code=>!source.permissions.includes(code))));
  assert(ordinaryDetail.item.businessRoles[0].permissions.includes('permissions.assignments.write'),'Stored role definition remains intact');
  assert(ordinaryDetail.roles.every(role=>role.canAssign===false));
  assert.equal((await service.list(ordinary)).capabilities.canCreate,false);
  const ordinaryAssignmentId=randomUUID();
  await assert.rejects(permissions.saveAssignment(ordinary,{operationId:ordinaryAssignmentId,expectedVersion:0,operatorId:promoted.operatorId,roleId:roles.spare,enabled:true},as(ordinary)),denied('operations_permission_denied'));
  const ordinaryCommandId=randomUUID();
  await assert.rejects(service.command(ordinary,ordinary.operatorId,{operationId:ordinaryCommandId,kind:'profile-update',expectedVersion:ordinaryDetail.targetVersion,note:'Must not write'},as(ordinary)),denied('operations_permission_denied'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1 WHERE id=$1',[ordinaryAssignmentId])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_management_commands_v1 WHERE operation_id=$1',[ordinaryCommandId])).rows[0].n,0);
  t.diagnostic('ordinary role mistakenly contains all 8 maintenance codes; effective/source/caps and generic saveAssignment all reject without a command/event');

  // Caller fields never select the fixed root identity or native qualification.
  const forged={...ordinary,role:'administrator',issuer,externalSubject:people[0].externalSubject};
  assert.equal(await stored(forged),'reader');assert.equal(await maintainer(forged),false);
  assert.deepEqual((await permissions.effective(forged)).permissions,[...readable].sort());
  assert.equal((await permissions.effective(root)).source,'preconfigured-root');
  assert.equal(await maintainer(root),true);

  // Being promoted makes admission eligible, but does not add business rights.
  assert.equal(await maintainer(promoted),true);
  assert.deepEqual((await permissions.effective(promoted)).permissions,[...readable].sort());
  const limited=await service.detail(promoted,ordinary.operatorId);
  assert.equal(limited.capabilities.canEditProfile,false);assert.equal(limited.capabilities.canAssignRoles,false);
  await assert.rejects(permissions.requireAction(promoted,'management.accounts.profile.write'),denied('operations_permission_denied'));
  const assigned=await service.assignment(root,promoted.operatorId,{operationId:randomUUID(),expectedVersion:0,roleId:roles.all,enabled:true},as(root));
  assert.equal(assigned.assignment.enabled,true);
  const qualified=await permissions.effective(promoted);
  assert.equal(qualified.role,'reader');assert.equal(qualified.source,'business-roles');
  for(const code of expectedCodes)assert(qualified.permissions.includes(code),code);
  assert.equal(qualified.permissions.includes('maintenance.read'),false,'A promoted administrator does not receive unrelated permissions');
  const current=await service.detail(promoted,ordinary.operatorId);
  assert.equal(current.capabilities.canEditProfile,true);assert.equal(current.capabilities.canAssignRoles,true);
  assert.equal(current.capabilities.canChangeAdmission,false,'Promotion remains fixed-root-only');
  const saved=await service.command(promoted,ordinary.operatorId,{operationId:randomUUID(),kind:'profile-update',expectedVersion:current.targetVersion,note:'Synthetic permitted local note'},as(promoted));
  assert.equal(saved.state,'completed');assert.deepEqual(saved.result.phases.map(row=>[row.kind,row.state]),[['local-principal','confirmed']]);
  assert.equal((await db.query('SELECT note FROM operations_management_accounts_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,ordinary.operatorId])).rows[0].note,'Synthetic permitted local note');
  const promotionTarget=await service.detail(promoted,ordinary.operatorId);
  await assert.rejects(service.command({...promoted,role:'administrator'},ordinary.operatorId,{operationId:randomUUID(),kind:'admission-change',expectedVersion:promotionTarget.targetVersion,action:'promote'},as({...promoted,role:'administrator'})),denied('management_root_only'));
  t.diagnostic('promoted admission without a role remains read-only; root-assigned maintenance role allows a real PG note write but never grants root-only promotion or unrelated actions');

  // Native demotion occurs after the initial permission check, before the
  // same command's transactional recheck. The cached role list still says admin.
  const lateId=randomUUID();let authorizeCalls=0;
  const beforeAuthority=(await db.query('SELECT version FROM operations_permission_authority_v1 WHERE endpoint=$1',[endpoint])).rows[0].version;
  await assert.rejects(permissions.saveAssignment(promoted,{operationId:lateId,expectedVersion:0,operatorId:ordinary.operatorId,roleId:roles.spare,enabled:true},{
   authorize:async()=>{authorizeCalls++;if(authorizeCalls===2)live.get(people[2].externalSubject).admission='reader';return {...promoted,role:'administrator'};},
  }),denied('operations_permission_denied'));
  assert.equal(authorizeCalls,2,'Initial check passed; the transactional fresh check observed demotion');
  assert.deepEqual(cachedNames.get(people[2].externalSubject),[nativeRoles.administrator]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_role_assignments_v1 WHERE endpoint=$1 AND operator_id=$2 AND role_id=$3',[endpoint,ordinary.operatorId,roles.spare])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1 WHERE id=$1',[lateId])).rows[0].n,0);
  assert.equal((await db.query('SELECT version FROM operations_permission_authority_v1 WHERE endpoint=$1',[endpoint])).rows[0].version,beforeAuthority);
  const demoted=await service.detail(root,promoted.operatorId);
  assert(expectedCodes.every(code=>!demoted.effective.permissions.includes(code)));
  assert(demoted.effective.sources.every(source=>expectedCodes.every(code=>!source.permissions.includes(code))));
  assert(demoted.item.businessRoles.some(role=>role.id===roles.all&&expectedCodes.every(code=>role.permissions.includes(code))));
  t.diagnostic('late native demotion with stale cached admission rejects inside the actual assignment transaction; no assignment, event or authority-version increment');

  // The local login/deletion state also precedes all native qualification.
  live.get(people[2].externalSubject).admission='administrator';
  await db.query('UPDATE operations_management_accounts_v1 SET login_blocked=true WHERE endpoint=$1 AND operator_id=$2',[endpoint,promoted.operatorId]);
  const readsBefore=reads.length;
  await assert.rejects(maintainer(promoted),denied('operations_access_denied'));
  assert.equal(reads.length,readsBefore,'Local inactive state fails before native qualification');
  await db.query('UPDATE operations_management_accounts_v1 SET login_blocked=false WHERE endpoint=$1 AND operator_id=$2',[endpoint,promoted.operatorId]);
  await transaction(db,async connection=>{
   assert.equal(await maintainer(promoted,{db:connection}),true);
   await connection.query('UPDATE operations_management_accounts_v1 SET login_blocked=true WHERE endpoint=$1 AND operator_id=$2',[endpoint,promoted.operatorId]);
   await assert.rejects(maintainer(promoted,{db:connection}),denied('operations_access_denied'));
   await connection.query('UPDATE operations_management_accounts_v1 SET login_blocked=false WHERE endpoint=$1 AND operator_id=$2',[endpoint,promoted.operatorId]);
  });

  // A fixed root has rights despite a reader-shaped caller, but its own
  // stop/delete/admission/role identity remains protected by the real service.
  const self=await service.detail(root,root.operatorId);
  assert.equal(self.item.rootAdministrator,true);assert.equal(self.effective.sources[0].kind,'preconfigured-root');
  for(const cap of ['canDisableLogin','canRestoreLogin','canDelete','canAssignRoles','canChangeAdmission'])assert.equal(self.capabilities[cap],false,cap);
  const rootStop=randomUUID();
  await assert.rejects(service.command(root,root.operatorId,{operationId:rootStop,kind:'login-disable',expectedVersion:self.targetVersion},as(root)),denied('management_root_protected'));
  await assert.rejects(service.assignment(root,root.operatorId,{operationId:randomUUID(),expectedVersion:0,roleId:roles.spare,enabled:true},as(root)),denied('management_root_protected'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_management_commands_v1 WHERE operation_id=$1',[rootStop])).rows[0].n,0);
  assert.equal((await service.detail(root,root.operatorId)).item.enabled,true);
  assert.equal(unexpectedEffects.length,0,'Only the explicit synthetic PG note and bounded role assignment wrote; no native effect was invoked');
  t.diagnostic('immutable stored subject defeats forged caller role; current local active state gates qualification; fixed root protection remains intact');
 });

