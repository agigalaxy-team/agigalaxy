import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyContextV2} from '../context-v2-workflow.mjs';
test('actual PostgreSQL API role supports independent Context grants without editing originals',{timeout:60000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),runtime=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
 try{await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
  const result=await verifyContextV2({database:runtime,repositories:apiReads,migrateDatabase:false});
  await assert.rejects(runtime.query('UPDATE context_grants_v2 SET payload_text=payload_text'),/permission denied/);
  await assert.rejects(runtime.query('DELETE FROM context_grants_v2'),/permission denied/);
  await assert.rejects(runtime.query('UPDATE context_events_v2 SET payload_hash=payload_hash'),/permission denied/);
  console.log(JSON.stringify({event:'context_v2_actual_pg_verified',...result,apiRole:true}));
 }finally{await runtime.end();await admin.end();}
});
