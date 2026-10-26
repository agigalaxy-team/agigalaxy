import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyIdentityGroupV2} from '../identity-group-v2-workflow.mjs';
test('Restricted PostgreSQL identity group dual signatures and recovery',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:15000});
 try{await migrate(admin,{roles:['api']});await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
 const report=await verifyIdentityGroupV2({database:api,adminDatabase:admin,workerDatabase:worker,repositories:apiReads,migrateDatabase:false});
 await assert.rejects(api.query("UPDATE identity_group_approvals_v2 SET signature=''"),/permission denied/);await assert.rejects(worker.query("UPDATE identity_groups_v2 SET state='active'"),/permission denied/);
 console.log(JSON.stringify({event:'identity_group_v2_verified',...report,actualApiRole:true,actualWorkerRole:true}));
 }finally{await worker.end();await api.end();await admin.end();}
});
