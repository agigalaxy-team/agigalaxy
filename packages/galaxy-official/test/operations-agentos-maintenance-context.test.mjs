import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsMaintenanceService} from "../src/operations/maintenance/service.mjs";
import {AiWorkAccountsReadModel} from '../src/operations/accounts/ai-work-read-model.mjs';
import {bindOperationsAiUse,withOperationsAiWork,operationsAiWorkScope} from '../src/shared/operations-ai-use.mjs';
import {operationsPermissionsV1MigrationSql} from '../src/infrastructure/operations-permissions-v1-schema.mjs';
import {operationsAiWorkAccountsV1MigrationSql} from '../src/infrastructure/operations-ai-work-accounts-v1-schema.mjs';

test('maintenance overview revalidation preserves attested AI context and actual current role intersection without granting root business authority',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());const endpoint='https://official.synthetic.invalid',owner='maintenance-root-synthetic',now=()=>1988193660,at=new Date(now()*1000);
 await db.exec('CREATE TABLE operations_operator_principals_v1(operator_id text PRIMARY KEY,endpoint text NOT NULL)');
 await db.query('INSERT INTO operations_operator_principals_v1 VALUES($1,$2)',[owner,endpoint]);
 await db.exec(operationsPermissionsV1MigrationSql);
 await db.exec(operationsAiWorkAccountsV1MigrationSql.split('ALTER TABLE operations_automation_grants_v1')[0]);
 await db.exec("CREATE SCHEMA galaxy_jobs; CREATE TABLE galaxy_jobs.job(name text,state text); INSERT INTO galaxy_jobs.job VALUES('information-watch','failed')");
 // Audit is an explicit fixture sink; authorization and role/AI storage use the actual schemas above.
 await db.exec('CREATE TABLE business_admin_audit_v1(sequence bigserial PRIMARY KEY,id uuid,endpoint text,operator_id text,operator_role text,action text,account_id uuid,operation_id uuid,http_request_id uuid,selection jsonb,result jsonb,created_at timestamptz,actor_kind text,execution_id uuid,grant_id uuid,actor_context jsonb)');
 const accountId=randomUUID(),roleId=randomUUID(),assignmentId=randomUUID();
 await db.query("INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'运行诊断协作','',true,1,ARRAY['maintenance.read','maintenance.logs.read'],$3,$3,$4,$4)",[roleId,endpoint,owner,at]);
 await db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'maintenance','运维','',true,1,1,$3,$3)",[accountId,endpoint,at]);
 await db.query("INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$5)",[assignmentId,endpoint,accountId,roleId,at]);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async person=>person.operatorId===owner?'administrator':null,now});
 const businessAdmin=new BusinessAdminService({db,endpoint,permissions,now});
 const accounts=new AiWorkAccountsReadModel({db,endpoint,businessAdmin,now});
 const person={kind:'business-operator',operatorId:owner,endpoint,role:'administrator'};
 const actor=withOperationsAiWork(bindOperationsAiUse({...person},'maintenance'),{accountId,purpose:'query',resolve:(tx,domain,options)=>accounts.authorizationWithin(tx,domain,options)});
 let nativeCalls=0,revokeDuringNative=false;
 const native={async call(input){nativeCalls++;assert.equal(input.kind,'overview');if(revokeDuringNative)await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE id=$1',[assignmentId]);return {components:[]};}};
 const maintenance=new OperationsMaintenanceService({businessAdmin,native,now});
 const value=await maintenance.overview(actor);
 assert.equal(value.queues.availability.state,'available');
 assert.equal(value.queues.items.find(row=>row.name==='information-watch').counts.failed,1);
 assert.equal(value.permissions.canReadLogs,true);
 assert.equal(value.permissions.canCreateBackup,false);
 assert.equal(value.permissions.canApproveRestore,false);
 assert.equal(value.permissions.canExecuteRestore,false);
 const revalidated=await businessAdmin.revalidate(actor);
 assert.deepEqual(operationsAiWorkScope(revalidated),{domain:'maintenance',accountId,purpose:'query'});
 assert(revalidated.businessAuthorization.permissions.includes('maintenance.read'));
 assert(!revalidated.businessAuthorization.permissions.includes('maintenance.restore.execute'));
 assert(!revalidated.businessAuthorization.permissions.includes('permissions.assignments.write'));
 // An ordinary spread remains unauthenticated; only the audited inheritance boundary may attest the clone.
 assert.throws(()=>businessAdmin.require({...actor}),{code:'operations_agentos_ai_use_denied'});
 await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=false WHERE id=$1',[assignmentId]);
 const previous=nativeCalls;await assert.rejects(maintenance.overview(actor),{code:'operations_permission_denied'});assert.equal(nativeCalls,previous);
 await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=true WHERE id=$1',[assignmentId]);revokeDuringNative=true;
 await assert.rejects(maintenance.overview(actor),{code:'operations_permission_denied'});
 assert.equal((await db.query("SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE action='maintenance-query'")).rows[0].n,1);
});

