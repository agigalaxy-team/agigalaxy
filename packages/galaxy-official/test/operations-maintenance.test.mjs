import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsMaintenanceService} from "../src/operations/maintenance/service.mjs";
import {operationsMaintenanceMigrationSql} from '../src/infrastructure/operations-maintenance-v1-schema.mjs';
import {maintenanceModuleIds,maintenanceOpeningConditions} from "../src/operations/maintenance/catalog.mjs";
import {migrate} from "../src/infrastructure/database.mjs";

// Real PGlite migrations, PG business roles, CAS, audit and command ledger.
// The management directory and native maintenance transport below are doubles;
// no backup, restore, credential read, provider or object-store operation occurs.
test('maintenance binds concrete approvals and native commands to current PG authority, full catalog scope and stable intent',async t=>{
 const f=await accountChatFixture();t.after(f.close);
 if(!(await f.db.query("SELECT to_regclass('public.operations_maintenance_plans_v1') AS relation")).rows[0].relation)await f.db.exec(operationsMaintenanceMigrationSql);
 const admin={kind:'business-operator',operatorId:'maintenance-synthetic-admin',role:'administrator',endpoint:f.endpoint,httpRequestId:randomUUID()},reader={...admin,operatorId:'maintenance-synthetic-reader',role:'reader'};
 const roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operations.example.invalid',$1,'本地合成管理人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async a=>roles.get(a.operatorId),now:f.now});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now});
 const codes=['maintenance.read','maintenance.logs.read','maintenance.backups.create','maintenance.backups.verify','maintenance.restore.plan','maintenance.restore.approve','maintenance.restore.execute'];
 const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成整站维护角色',description:'仅本次本地行为验证',enabled:true,permissions:codes},{authorize:async()=>admin})).role;
 const assignment=(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin})).assignment;
 const pointId='a'.repeat(64),footprintDigest='b'.repeat(64),nowIso=new Date(f.now()*1000).toISOString();
 const coverage=maintenanceModuleIds.map(id=>({id,state:'covered',sourceIds:[],postgresStanzas:['business'],method:'pgbackrest-cluster',reasonCodes:[]}));
 const point={id:pointId,createdAt:new Date((f.now()-1800)*1000).toISOString(),logicalBytes:1024,logicalFileCount:4,integrity:{state:'verified',checkedAt:nowIso},coverage,capture:{state:'available',startedAt:new Date((f.now()-1810)*1000).toISOString(),finishedAt:new Date((f.now()-1805)*1000).toISOString(),consistency:'named-pg-points-and-bounded-quiesced-files'}};
// eslint-disable-next-line prefer-const -- Forward references must stay initialized to undefined when setup fails before assignment.
 let executable=false;let starts=0;let dropAck=false;let service;const operations=new Map();
 const native={async call(x){
  if(x.kind==='overview')return{availability:{state:'available'},components:[{id:'api',processState:'running',health:'unknown',healthBasis:'systemd-process',checkedAt:nowIso}],storage:[{id:'host-filesystem',availability:{state:'available'},capacityBytes:100,availableBytes:40,usedBytes:50,observedAt:nowIso}],coverage,errors:{availability:{state:'unavailable'},count:null},secret:'must-not-cross-projection'};
  if(x.kind==='catalog')return{items:[point],total:70,nextAfter:pointId,coverage,policy:{calendar:'*-*-* 03:15:00 UTC',timer:{state:'active',enabled:true},retention:{daily:14,weekly:8,monthly:6},repository:{location:'same-host',encrypted:true},repositoryUrl:'must-not-cross-projection'},capabilities:{backupCreate:true,backupVerify:true}};
  if(x.kind==='point')return{point};
  if(x.kind==='logs')return{components:['api'],items:[{at:nowIso,level:'error',component:'api',event:'http_completed',code:'unexpected-private-free-text',body:'must-not-cross-projection',password:'must-not-cross-projection',diagnostic:'failure',status:500}],nextBefore:'1792725810000000000'};
  if(x.kind==='restore-preview')return{point,moduleIds:x.moduleIds,productionExecutable:executable,footprintDigest,adapterVersion:'synthetic-native-v1',blockers:executable?[]:['maintenance_production_adapter_unavailable']};
  if(x.kind==='operation')return operations.get(x.operationId)??null;
  const auth={operationId:x.operationId,operatorId:x.operatorId,kind:x.kind,...(x.kind==='backup-verify'?{pointId:x.pointId}:{}),...(x.kind==='restore-execute'?{planId:x.planId,revision:x.revision,planDigest:x.planDigest,pointId:x.pointId,moduleIds:x.moduleIds,footprintDigest:x.footprintDigest,openingConditions:x.openingConditions,approvedAt:x.approvedAt}:{})};
  assert.equal((await service.authorizeNative(auth)).authorized,true,'native sees an already committed, currently authorized intent');
  if(!operations.has(x.operationId)){starts++;operations.set(x.operationId,{id:x.operationId,kind:x.kind,state:'running',startedAt:nowIso,publicActivation:false,steps:[]});}
  if(dropAck){dropAck=false;throw Object.assign(Error('synthetic lost ACK'),{code:'maintenance_native_unavailable',status:503});}
  return operations.get(x.operationId);
 }};
 service=new OperationsMaintenanceService({businessAdmin,native,incident:{snapshot:()=>({state:'normal',businessWritesAccepted:true,revision:null})},now:f.now});
 const options={authorize:async()=>reader};
 await f.db.query("INSERT INTO galaxy_jobs.job(id,name,state,data) VALUES($1,'information-watch','created','{}'),($2,'search-recovery','failed','{}')",[randomUUID(),randomUUID()]);
 const overview=await service.overview(reader);assert.equal(overview.queues.scope,'registered-business-pg-boss-queues');assert.equal(overview.queues.includesAllPlatformQueues,false);assert.equal(overview.queues.items.find(x=>x.name==='information-watch').counts.created,1);assert.equal(overview.queues.items.find(x=>x.name==='search-recovery').counts.failed,1);
 assert.equal(overview.components.find(x=>x.id==='api').health,'unknown');assert.equal(overview.storage.find(x=>x.id==='object-repository').usedBytes,null);assert.equal(overview.ai.requiredForCodeExecution,false);assert.equal(overview.maintenanceMode.state,'normal');
 const catalog=await service.backups(reader);assert.equal(catalog.total,70);assert.equal(catalog.items.length,1);assert.equal(catalog.policy.timer.enabled,true);assert.equal(catalog.policy.offHostPolicy,'undecided');assert.equal(catalog.items[0].integrity.state,'verified');
 const logs=await service.logs(reader);assert.equal(logs.items[0].code,'other_error');assert.equal(logs.nextBefore,'1792725810000000000');assert.ok(!JSON.stringify({overview,catalog,logs}).includes('must-not-cross-projection'));assert.ok(!JSON.stringify(logs).includes('unexpected-private-free-text'));
 const blocked=await service.createPlan(reader,{operationId:randomUUID(),pointId,scope:'whole-site'},options);assert.equal(blocked.state,'blocked');
 await assert.rejects(service.approvePlan(reader,blocked.planId,{operationId:randomUUID(),expectedRevision:1,expectedPlanDigest:blocked.planDigest,acknowledgement:{point:true,scope:true,possibleLoss:true,openingConditions:true}},options),{code:'maintenance_plan_not_approvable'});assert.equal(starts,0);
 executable=true;const made=await service.createPlan(reader,{operationId:randomUUID(),pointId,scope:'whole-site'},options);assert.equal(made.state,'awaiting-approval');
 const recoveryPlan=(await service.plan(reader,made.planId)).plan;
 assert.deepEqual(recoveryPlan.preservedCurrent,{state:'declared',items:['accounts','passwords','current-permissions','keys'],basis:'current-security-authority'});
 assert.equal(recoveryPlan.modules.find(x=>x.id==='accounts').restoreBasis,'current-security-authority');
 assert.equal(recoveryPlan.modules.find(x=>x.id==='business').restoreBasis,'point-with-current-permissions');
 const oldId=randomUUID();await f.db.query("INSERT INTO operations_maintenance_plans_v1(id,endpoint,revision,point_id,state,plan,plan_digest,created_by,created_at,updated_at) SELECT $1,endpoint,revision,point_id,state,plan-'preservedCurrent',plan_digest,created_by,created_at,updated_at FROM operations_maintenance_plans_v1 WHERE id=$2",[oldId,made.planId]);
 assert.equal((await service.plan(reader,oldId)).plan.preservedCurrent.state,'not-recorded');
 await assert.rejects(service.approvePlan(reader,oldId,{operationId:randomUUID(),expectedRevision:1,expectedPlanDigest:made.planDigest,acknowledgement:{point:true,scope:true,possibleLoss:true,openingConditions:true}},options),{code:'maintenance_security_preservation_not_recorded'});
 const approve={operationId:randomUUID(),expectedRevision:1,expectedPlanDigest:made.planDigest,acknowledgement:{point:true,scope:true,possibleLoss:true,openingConditions:true}};
 await assert.rejects(service.approvePlan(reader,made.planId,{...approve,expectedPlanDigest:'c'.repeat(64)},options),{code:'maintenance_plan_changed'});
 const approved=await service.approvePlan(reader,made.planId,approve,options);assert.equal(approved.revision,2);assert.equal((await service.approvePlan(reader,made.planId,approve,options)).replayed,true);
 const execute={operationId:randomUUID(),expectedRevision:2};const executing=await service.executePlan(reader,made.planId,execute,options);assert.equal(executing.state,'preparing');assert.equal(executing.operation.publicActivation,false);assert.equal(starts,1);
 assert.equal((await service.executePlan(reader,made.planId,execute,options)).replayed,true);assert.equal(starts,1);
 const saved=(await f.db.query('SELECT * FROM operations_maintenance_plans_v1 WHERE id=$1',[made.planId])).rows[0];
 const bound={operationId:execute.operationId,operatorId:reader.operatorId,kind:'restore-execute',planId:made.planId,revision:2,planDigest:made.planDigest,pointId,moduleIds:saved.plan.moduleIds,footprintDigest,openingConditions:[...maintenanceOpeningConditions],approvedAt:new Date(saved.approved_at).toISOString()};
 await assert.rejects(service.authorizeNative({...bound,moduleIds:['business']}),{code:'maintenance_execution_not_authorized'});
 await assert.rejects(service.authorizeNative({...bound,pointId:'d'.repeat(64)}),{code:'maintenance_execution_not_authorized'});
  const plan=await service.plan(reader,made.planId);assert.equal(plan.plan.approval.operatorId,reader.operatorId);assert.equal(plan.plan.possibleLoss.maximumSeconds,null);assert.equal(plan.plan.possibleLoss.through,'related-writer-pause');assert.equal(plan.operation.publicActivation,false);assert.equal(plan.plan.productionActivation,'not-opened');
  const executionRow=operations.get(execute.operationId);executionRow.state='unknown';executionRow.publicActivation=null;assert.equal((await service.plan(reader,made.planId)).plan.productionActivation,'unknown');executionRow.state='succeeded';executionRow.publicActivation=true;executionRow.planState='completed';assert.equal((await service.plan(reader,made.planId)).plan.productionActivation,'recorded-by-approved-executor');
 const backup={operationId:randomUUID(),kind:'create'};dropAck=true;await assert.rejects(service.runBackup(reader,backup,options),{code:'maintenance_native_unavailable'});const afterLoss=starts;
 assert.equal((await service.runBackup(reader,backup,options)).replayed,true);assert.equal(starts,afterLoss);
 const audit=(await f.db.query("SELECT operator_role,selection,result FROM business_admin_audit_v1 WHERE action LIKE 'maintenance-%'")).rows;assert.ok(audit.length>0);assert.ok(audit.every(x=>x.operator_role==='reader'));assert.ok(!JSON.stringify(audit).includes('must-not-cross-projection'));
 assert.ok((await f.db.query("SELECT 1 FROM operations_maintenance_events_v1 WHERE action='restore-approve' AND plan_id=$1",[made.planId])).rows.length);
 await permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:role.id,enabled:false},{authorize:async()=>admin});
 const beforeRevoked=starts;await assert.rejects(service.runBackup(reader,backup,options),{code:'operations_permission_denied'});await assert.rejects(service.authorizeNative(bound),{code:'operations_permission_denied'});assert.equal(starts,beforeRevoked);
  await migrate(f.db,{roles:['api','worker']});
  try{
   await f.db.exec('SET ROLE galaxy_api');
   assert.equal((await f.db.query('SELECT id FROM operations_maintenance_plans_v1 WHERE id=$1',[made.planId])).rows.length,1);
   await f.db.query("UPDATE operations_maintenance_plans_v1 SET updated_at=$2 WHERE id=$1",[made.planId,new Date(f.now()*1000)]);
   await assert.rejects(f.db.query("UPDATE operations_maintenance_plans_v1 SET plan='{}' WHERE id=$1",[made.planId]),/permission denied/);
   await assert.rejects(f.db.query('DELETE FROM operations_maintenance_plans_v1 WHERE id=$1',[made.planId]),/permission denied/);
   await assert.rejects(f.db.query("UPDATE operations_maintenance_events_v1 SET result='{}'"),/permission denied/);
   await f.db.exec('RESET ROLE; SET ROLE galaxy_evidence_worker');
   await assert.rejects(f.db.query('SELECT id FROM operations_maintenance_plans_v1'),/permission denied/);
  }finally{await f.db.exec('RESET ROLE');}
});
