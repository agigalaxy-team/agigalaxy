import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from '../src/database.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {operationsPermissionCatalogV2Codes} from '../src/infrastructure/operations-permission-catalog-v2-schema.mjs';
import {operationsPermissionCodes} from '../src/operations-permission-catalog.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';

const arraySql=codes=>'ARRAY['+codes.map(code=>"'"+code+"'").join(',')+']::text[]';

// The 62-code fixture is the actual read-only pg_constraint metadata observed
// at production schema 118. An all-fresh migration would expand today's catalog
// into 103 and conceal this upgrade defect. Only that historical CHECK literal
// is substituted in the local 103 SQL below; no released SQL source is edited.
// The legacy CHECK is exercised as fixture owner; the current API role is
// installed only after the complete append-only upgrade. Permission commands
// and rollback remain real, without applying modern column grants to schema118. The
// upstream management directory is an explicit fixture, with no native/model,
// production grant, assignment, configuration or provider operation.
test('schema 118 legacy permission checks upgrade atomically to the current closed catalog without changing existing grants',{timeout:90000},async t=>{
 const legacy=JSON.parse(await readFile(new URL('./fixtures/operations-permissions-v1-legacy-codes.json',import.meta.url),'utf8'));
 assert.equal(legacy.length,62);assert.equal(new Set(legacy).size,legacy.length);
 assert(legacy.every(code=>operationsPermissionCodes.includes(code)));
 assert(operationsPermissionCatalogV2Codes.every(code=>operationsPermissionCodes.includes(code)),'historical permission codes remain accepted by the current catalog');
 const db=new PGlite();t.after(()=>db.close());
 const baselineArray=arraySql(operationsPermissionCodes.filter(code=>!code.startsWith('ai.prompts.'))),legacyArray=arraySql(legacy),baseline=migrations.filter(m=>m.version<=118);
 assert.equal(baseline.at(-1).version,118);assert(migrations.at(-1).version>=119);
 await transaction(db,async tx=>{
  await tx.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const migration of baseline){
   let sql=migration.sql;
   if(migration.version===103){assert.equal(sql.split(baselineArray).length-1,2);sql=sql.replaceAll(baselineArray,legacyArray);}
   await tx.exec(sql);await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
  }
 });
 const checks=async()=>{
  const rows=(await db.query(`SELECT r.relname,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid WHERE r.relname IN ('operations_business_roles_v1','operations_automation_grants_v1') AND c.contype='c'`)).rows;
  return rows.filter(row=>row.definition.includes('permissions')&&row.definition.includes('<@')).map(row=>({table:row.relname,codes:[...row.definition.matchAll(/'([a-z][a-z0-9.-]{0,99})'/g)].map(match=>match[1]).sort((a,b)=>a<b?-1:a>b?1:0)})).sort((a,b)=>a.table.localeCompare(b.table));
 };
 assert.deepEqual((await checks()).map(row=>row.codes),[[...legacy].sort((a,b)=>a<b?-1:a>b?1:0),[...legacy].sort((a,b)=>a<b?-1:a>b?1:0)]);
 const endpoint='https://permission-upgrade.example',actor={kind:'business-operator',operatorId:'upgrade-synthetic-admin',role:'administrator',endpoint},at='2030-01-01T00:00:00.000Z',now=()=>1893456000;
 await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.invalid',$1,'本地升级夹具',$3,$3)",[actor.operatorId,endpoint,at]);
 const service=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async current=>current.operatorId===actor.operatorId?'administrator':null,now}),options={authorize:async()=>actor};
 const roleInput=(permissions,name)=>({operationId:randomUUID(),expectedVersion:0,name,description:'仅合成升级验证，未分配',enabled:true,permissions});
 const targetId=randomUUID(),automationInput=(permissions,name)=>({operationId:randomUUID(),expectedVersion:0,name,executorKind:'program',mode:'assisted',enabled:false,permissions,resourceIds:[targetId],resourceScope:{kind:'selected',resourceIds:[targetId]}});
 const insertRole=(id,codes,name)=>db.query("INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,'',true,1,$4,$5,$5,$6,$6)",[id,endpoint,name,codes,actor.operatorId,at]);
 const insertAutomation=(id,codes,name)=>db.query("INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,resource_scope_kind,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,'program','assisted',false,1,$4,$5,'selected',$6,$6,$7,$7)",[id,endpoint,name,codes,[targetId],actor.operatorId,at]);
 const oldRole={role:{id:randomUUID()}},oldAutomation={automation:{id:randomUUID()}};
 await insertRole(oldRole.role.id,['workbench.read'],'既有未分配角色');
 await insertAutomation(oldAutomation.automation.id,['content.read'],'既有停用授权');
 const role=roleInput([...operationsPermissionCodes],'包含当前全部闭合代码的未分配角色');
 const automation=automationInput(['recommendations.read','search-quality.read','strategies.read'],'包含新增代码的停用授权');
 await assert.rejects(insertRole(randomUUID(),role.permissions,role.name),{code:'23514'});
 await assert.rejects(insertAutomation(randomUUID(),automation.permissions,automation.name),{code:'23514'});
 const snapshot=async()=>({roles:(await db.query('SELECT * FROM operations_business_roles_v1 ORDER BY id')).rows,automation:(await db.query('SELECT * FROM operations_automation_grants_v1 ORDER BY id')).rows,assignments:(await db.query('SELECT * FROM operations_role_assignments_v1 ORDER BY id')).rows,authority:(await db.query('SELECT * FROM operations_permission_authority_v1 ORDER BY endpoint')).rows,events:(await db.query('SELECT * FROM operations_permission_events_v1 ORDER BY sequence')).rows});
 const before=await snapshot();assert.equal(before.assignments.length,0);
 await db.exec('RESET ROLE');
 assert.equal(await migrate(db,{roles:['api']}),migrations.at(-1).version,'the real migration runner upgrades the schema-118 fixture through all current append-only migrations');
 const after=await snapshot();
 const preserved=Object.fromEntries(Object.entries(after).map(([table,rows])=>[table,rows.map(row=>Object.fromEntries(Object.keys(before[table][0]??row).map(key=>[key,row[key]])))]));
 assert.deepEqual(preserved,before,'append-only upgrade must retain every original column of existing grants and assignments');
 assert.deepEqual((await checks()).map(row=>row.codes),[[...operationsPermissionCodes].sort((a,b)=>a<b?-1:a>b?1:0),[...operationsPermissionCodes].sort((a,b)=>a<b?-1:a>b?1:0)]);
 await db.exec('SET ROLE galaxy_api');
 const savedRole=await service.saveRole(actor,role,options),savedAutomation=await service.saveAutomation(actor,automation,options);
 assert.deepEqual(savedRole.role.permissions,role.permissions);assert.equal(savedRole.role.version,1);
 assert.deepEqual(savedAutomation.automation.permissions,automation.permissions);assert.equal(savedAutomation.automation.enabled,false);assert.deepEqual(savedAutomation.automation.resourceScope,automation.resourceScope);
 assert.equal((await service.saveRole(actor,role,options)).replayed,true);assert.equal((await service.saveAutomation(actor,automation,options)).replayed,true);
 assert.equal((await service.operation(actor,role.operationId)).result.role.id,savedRole.role.id);
 assert.equal((await service.operation(actor,automation.operationId)).result.automation.id,savedAutomation.automation.id);
 assert.equal((await service.role(actor,oldRole.role.id)).role.version,1);assert.equal((await service.automation(actor)).items.find(row=>row.id===oldAutomation.automation.id).enabled,false);
 await assert.rejects(db.query('UPDATE operations_business_roles_v1 SET permissions=$2 WHERE id=$1',[savedRole.role.id,['unknown.permission']]),{code:'23514'});
 await assert.rejects(db.query('UPDATE operations_automation_grants_v1 SET permissions=$2 WHERE id=$1',[savedAutomation.automation.id,['unknown.permission']]),{code:'23514'});
 await assert.rejects(service.saveRole(actor,roleInput(['unknown.permission'],'未知代码'),options),{code:'invalid_operations_permissions_request'});
 assert.equal(Number((await db.query('SELECT count(*) AS count FROM operations_role_assignments_v1')).rows[0].count),0);
 await db.exec('RESET ROLE');
 const rolePrivileges=(await db.query("SELECT has_table_privilege('galaxy_api','operations_business_roles_v1','DELETE') AS can_delete,has_table_privilege('galaxy_api','operations_permission_events_v1','UPDATE') AS can_rewrite_events")).rows[0];
 assert.deepEqual(rolePrivileges,{can_delete:false,can_rewrite_events:false});
});
