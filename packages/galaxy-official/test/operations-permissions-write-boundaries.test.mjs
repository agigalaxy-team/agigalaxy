import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";

// Real PGlite, current migrations, galaxy_api and fresh PG business grants.
// Only upstream management eligibility is an explicit local double. No real
// account/role/grant, native task, provider, model or production write occurs.
test('permission commands reject disabled-role activation and all human-only automation writes without changing authority or original records',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const endpoint='https://permission-write-boundary.example',now=()=>1893456000,at='2030-01-01T00:00:00.000Z';
 const admin={kind:'business-operator',operatorId:'boundary-admin',endpoint},manager={...admin,operatorId:'boundary-manager'},person={...admin,operatorId:'boundary-person'};
 const upstream=new Map([[admin.operatorId,'administrator'],[manager.operatorId,'reader'],[person.operatorId,'reader']]);
 for(const actor of [admin,manager,person])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.invalid',$1,'本地合成管理身份',$3,$3)",[actor.operatorId,endpoint,at]);
 const service=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async actor=>upstream.get(actor.operatorId),managementMaintainerAuthorization:async()=>true,now}),adminAuth={authorize:async()=>admin},managerAuth={authorize:async()=>manager};
 const roleInput=(name,permissions,enabled=true)=>({operationId:randomUUID(),expectedVersion:0,name,description:'合成权限边界验证',enabled,permissions});
 const management=(await service.saveRole(admin,roleInput('本地角色管理',['permissions.read','permissions.roles.write','permissions.assignments.write','permissions.automation.write','content.read','rules.write']),adminAuth)).role;
 await service.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:manager.operatorId,roleId:management.id,enabled:true},adminAuth);
 await db.exec('SET ROLE galaxy_api');
 assert((await service.effective(manager)).permissions.includes('rules.write'),'the acting reader really holds the human-only code, so subset is not the rejection reason');
 const manualInput=roleInput('真人角色可持人工动作',['rules.write'],false);
 let manual=(await service.saveRole(manager,manualInput,managerAuth)).role;
 assert.deepEqual(manual.permissions,['rules.write']);
 const snapshot=async()=>({authority:(await db.query('SELECT endpoint,version FROM operations_permission_authority_v1 ORDER BY endpoint')).rows,
  events:(await db.query('SELECT id,resource_id,version FROM operations_permission_events_v1 ORDER BY sequence')).rows,
  auditCount:Number((await db.query('SELECT count(*) AS count FROM business_admin_audit_v1')).rows[0].count),
  assignments:(await db.query('SELECT * FROM operations_role_assignments_v1 ORDER BY id')).rows,
  automation:(await db.query('SELECT * FROM operations_automation_grants_v1 ORDER BY id')).rows});
 const rejectsWithoutWrite=async(method,input,code,status)=>{
  const before=await snapshot();await assert.rejects(service[method](manager,input,managerAuth),{code,status});
  assert.deepEqual(await snapshot(),before,'rejected command must roll back authority, ledger, audit and target writes');
  assert.equal((await service.operation(manager,input.operationId)).state,'not-recorded');
 };
 const assignmentBase={expectedVersion:0,operatorId:person.operatorId,roleId:manual.id,enabled:true};
 await rejectsWithoutWrite('saveAssignment',{...assignmentBase,operationId:randomUUID()},'operations_permissions_target_changed',409);
 manual=(await service.saveRole(manager,{...manualInput,id:manual.id,operationId:randomUUID(),expectedVersion:manual.version,enabled:true},managerAuth)).role;
 const assigned=(await service.saveAssignment(manager,{...assignmentBase,operationId:randomUUID()},managerAuth)).assignment;
 assert((await service.requireAction(person,'rules.write')).businessAuthorization.permissions.includes('rules.write'),'a live human assignment may hold this action');
 manual=(await service.saveRole(manager,{...manualInput,id:manual.id,operationId:randomUUID(),expectedVersion:manual.version,enabled:false},managerAuth)).role;
 const beforeRevoke=(await db.query('SELECT enabled,version FROM operations_role_assignments_v1 WHERE id=$1',[assigned.id])).rows[0];
 assert.deepEqual(beforeRevoke,{enabled:true,version:1},'disabling the role does not rewrite the existing assignment');
 assert(!(await service.effective(person)).permissions.includes('rules.write'),'current effective permission already intersects role.enabled');
 await rejectsWithoutWrite('saveAssignment',{...assignmentBase,id:assigned.id,expectedVersion:1,operationId:randomUUID()},'operations_permissions_target_changed',409);
 const revoked=(await service.saveAssignment(manager,{...assignmentBase,id:assigned.id,expectedVersion:1,enabled:false,operationId:randomUUID()},managerAuth)).assignment;
 assert.equal(revoked.enabled,false);assert.equal(revoked.version,2);
 await rejectsWithoutWrite('saveAssignment',{...assignmentBase,id:assigned.id,expectedVersion:2,operationId:randomUUID()},'operations_permissions_target_changed',409);
 assert.deepEqual((await service.role(manager,manual.id)).role.permissions,['rules.write'],'the role is not stripped of the manual code');

 const targetId=randomUUID(),scope={kind:'selected',resourceIds:[targetId]};
 const automationInput=(executorKind,mode)=>({operationId:randomUUID(),expectedVersion:0,name:'明确拒绝人工动作 '+executorKind+' '+mode,executorKind,mode,enabled:false,permissions:['rules.write'],resourceIds:[targetId],resourceScope:scope});
 for(const executorKind of ['program','ai'])for(const mode of ['assisted','automatic'])await rejectsWithoutWrite('saveAutomation',automationInput(executorKind,mode),'operations_automation_human_boundary',403);

 // Older assisted records could contain a manual action. Preserve that exact
 // historical row; attempting an unrelated edit must reject, never clear codes.
 const legacyId=randomUUID();await db.exec('RESET ROLE');
 await db.query(`INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,resource_scope_kind,created_by,updated_by,created_at,updated_at)
  VALUES($1,$2,'历史原人工动作','ai','assisted',false,1,$3,$4,'selected',$5,$5,$6,$6)`,[legacyId,endpoint,['rules.write'],[targetId],admin.operatorId,at]);
 await db.exec('SET ROLE galaxy_api');
 const legacyBefore=(await db.query('SELECT * FROM operations_automation_grants_v1 WHERE id=$1',[legacyId])).rows[0];
 await rejectsWithoutWrite('saveAutomation',{...automationInput('ai','assisted'),id:legacyId,expectedVersion:1,name:'仅尝试改名'},'operations_automation_human_boundary',403);
 assert.deepEqual((await db.query('SELECT * FROM operations_automation_grants_v1 WHERE id=$1',[legacyId])).rows[0],legacyBefore);
 const safe=automationInput('program','assisted');safe.name='普通受限授权仍可保存';safe.permissions=['content.read'];
 const saved=await service.saveAutomation(manager,safe,managerAuth);assert.deepEqual(saved.automation.permissions,['content.read']);assert.equal(saved.automation.enabled,false);
 assert.equal((await service.saveAutomation(manager,safe,managerAuth)).replayed,true);
 assert.equal((await service.operation(manager,safe.operationId)).result.automation.id,saved.automation.id);
 await db.exec('RESET ROLE');
});
