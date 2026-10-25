import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {migrate,transaction} from '../src/database.mjs';
import {OperationsMessagingService} from '../src/operations-messaging.mjs';
import {workerReads} from '../src/infrastructure/worker-reads.mjs';

// Actual PG/API+galaxy_evidence_worker roles, old failing branch, the new
// explicitly provisioned SQL, actual messaging plan method and reader helper.
// No session/authorizer is fabricated and no queue, delivery, SMTP, notification
// or production access is exercised.
test('messaging worker locks only its exact endpoint plan in the caller transaction without plan UPDATE privilege',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api','worker']});
 const endpoint='https://worker-plan.example.invalid',otherEndpoint='https://other-plan.example.invalid',id=randomUUID(),foreignId=randomUUID(),at='2026-10-24T00:00:00.000Z',config={channels:['announcement'],content:{purpose:'service-update',title:'本地固定计划',body:'只检查固定行锁，不执行发布',href:null,expiresAt:'2033-05-18T04:33:20.000Z'},audience:{kind:'all-accounts'},senderKey:'notice',schedule:{kind:'immediate'}};
 for(const [plan,scope]of [[id,endpoint],[foreignId,otherEndpoint]]){await db.query("INSERT INTO operations_messaging_plans_v1(id,endpoint,version,revision,state,created_by,updated_by,approved_by,approved_role,approved_at,created_at,updated_at) VALUES($1,$2,1,2,'active','local-author','local-author','local-author','reader',$3,$3,$3)",[plan,scope,at]);await db.query('INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,1,$2,\'local-author\',$3)',[plan,JSON.stringify(config),at]);}
 const baseline=(await db.query('SELECT * FROM public.operations_messaging_plans_v1 WHERE id=$1',[id])).rows[0];
 assert.equal((await db.query("SELECT to_regprocedure('public.galaxy_worker_lock_messaging_plan(uuid,text)') IS NULL AS absent")).rows[0].absent,true);
 await db.exec('SET ROLE galaxy_evidence_worker');assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_evidence_worker');
 const old=new OperationsMessagingService({db,endpoint,now:()=>2000000000});
 assert.deepEqual((await old.planWithin(db,id)).config,config,'the existing worker can SELECT its plan and immutable version');
 await assert.rejects(transaction(db,tx=>old.planWithin(tx,id,{lock:true})),{code:'42501'},'the old worker path requires unauthorized UPDATE for FOR UPDATE');
 await assert.rejects(db.query("UPDATE public.operations_messaging_plans_v1 SET state='stopped' WHERE id=$1",[id]),{code:'42501'});
 t.diagnostic('old worker branch reproduced42501 and direct plan UPDATE denied');
 await db.exec('RESET ROLE');
 // Same explicit owner provisioning used by migrate({roles:['worker']}); no
 // migration number or runtime schema mutation is introduced.
 await db.exec(await readFile(new URL('../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
 const privileges=(await db.query("SELECT has_function_privilege('galaxy_evidence_worker','public.galaxy_worker_lock_messaging_plan(uuid,text)','EXECUTE') AS worker,has_function_privilege('galaxy_api','public.galaxy_worker_lock_messaging_plan(uuid,text)','EXECUTE') AS api")).rows[0];assert.equal(privileges.worker,true);assert.equal(privileges.api,false);
 const functionInfo=(await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.galaxy_worker_lock_messaging_plan(uuid,text)'::regprocedure")).rows[0];assert.equal(functionInfo.prosecdef,true);assert.ok(functionInfo.proconfig.includes('search_path=pg_catalog'));
 await db.exec('SET ROLE galaxy_evidence_worker');
 const limited=(await db.query("SELECT has_table_privilege(current_user,'public.operations_messaging_plans_v1','SELECT') AS readable,has_any_column_privilege(current_user,'public.operations_messaging_plans_v1','UPDATE') AS writable,has_table_privilege(current_user,'public.operations_messaging_plans_v1','INSERT') AS insertable,has_table_privilege(current_user,'public.operations_messaging_plans_v1','DELETE') AS deletable")).rows[0];
 assert.deepEqual(limited,{readable:true,writable:false,insertable:false,deletable:false});
 const worker=new OperationsMessagingService({db,endpoint,lockPlan:workerReads.lockMessagingPlan,now:()=>2000000000});
 await transaction(db,async tx=>{const locked=await worker.planWithin(tx,id,{lock:true});assert.equal(locked.id,id);assert.equal(locked.endpoint,endpoint);assert.deepEqual(locked.config,config);
  const held=(await tx.query("SELECT p.xmax::text AS row_locker,pg_current_xact_id()::text AS transaction_id,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.operations_messaging_plans_v1'::regclass AND mode='RowShareLock' AND granted) AS relation_lock FROM public.operations_messaging_plans_v1 p WHERE p.id=$1",[id])).rows[0];
  assert.equal(held.row_locker,held.transaction_id,'the row is locked by this same live caller transaction');assert.equal(held.relation_lock,true);
 });
 t.diagnostic('new helper locked exact plan in same caller transaction without UPDATE privilege');
 await assert.rejects(worker.planWithin(db,foreignId,{lock:true}),{code:'operations_messaging_plan_not_found'});
 await assert.rejects(worker.planWithin(db,randomUUID(),{lock:true}),{code:'operations_messaging_plan_not_found'});
 assert.equal((await workerReads.lockMessagingPlan(db,id,otherEndpoint)).rows.length,0);
 // A worker-created temp object cannot replace the fixed public immutable
 // version SELECT or the definer function's fixed public plan source.
 await db.exec('CREATE TEMP TABLE operations_messaging_versions_v1(plan_id uuid,version integer,config jsonb)');
 await db.query("INSERT INTO operations_messaging_versions_v1 VALUES($1,1,'{\"shadow\":true}')",[id]);
 assert.deepEqual((await transaction(db,tx=>worker.planWithin(tx,id,{lock:true}))).config,config);
 await assert.rejects(db.query("UPDATE public.operations_messaging_plans_v1 SET revision=revision+1 WHERE id=$1",[id]),{code:'42501'},'helper EXECUTE does not grant UPDATE after a lock');
 await db.exec('DROP TABLE pg_temp.operations_messaging_versions_v1');
 await db.exec('RESET ROLE');assert.deepEqual((await db.query('SELECT * FROM public.operations_messaging_plans_v1 WHERE id=$1',[id])).rows[0],baseline);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM public.operations_messaging_runs_v1')).rows[0].count,0);
 await db.exec('SET ROLE galaxy_api');await assert.rejects(db.query('SELECT * FROM public.galaxy_worker_lock_messaging_plan($1,$2)',[id,endpoint]),{code:'42501'});
 const api=new OperationsMessagingService({db,endpoint,now:()=>2000000000});assert.equal((await transaction(db,tx=>api.planWithin(tx,id,{lock:true}))).id,id,'the API default SELECT FOR UPDATE path is unchanged and remains allowed by its existing grants');
});

