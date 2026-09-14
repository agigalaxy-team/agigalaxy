import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from '../../src/database.mjs';
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyWatchControlV2} from '../watch-control-v2-workflow.mjs';
test('Restricted PostgreSQL watch handoff, same-ID cursor and owned lifecycle',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000}),
  worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:15000});
 try{await migrate(admin,{roles:['api']});await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
  const result=await verifyWatchControlV2({database:api,adminDatabase:admin,workerDatabase:worker,repositories:apiReads,migrateDatabase:false});
  await assert.rejects(api.query("UPDATE watch_control_operations_v2 SET result='{}'"),/permission denied/);
  await assert.rejects(worker.query("UPDATE watch_controls_v2 SET revision=99"),/permission denied/);
  console.log(JSON.stringify({event:'watch_control_v2_verified',...result,actualApiRole:true,actualWorkerRetentionRole:true}));
 }finally{await worker.end();await api.end();await admin.end();}
});
