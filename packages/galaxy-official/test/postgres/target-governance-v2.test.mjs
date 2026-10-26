import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyTargetGovernanceV2} from '../target-governance-v2-workflow.mjs';
test('PostgreSQL restricted API Task/Room governance, actual HTTP/browser client, independent Account and lifecycle',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:15000});
 try{
  await migrate(admin,{roles:['api']});await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
  const report=await verifyTargetGovernanceV2({database:api,adminDatabase:admin,workerDatabase:worker,repositories:apiReads,migrateDatabase:false});
  await assert.rejects(api.query("UPDATE target_governance_events_v2 SET payload_text=''"),/permission denied/);
  await assert.rejects(worker.query("UPDATE target_reports_v2 SET state='resolved'"),/permission denied/);
  console.log(JSON.stringify({event:'target_governance_pg_verified',...report,apiRole:true,workerRole:true,synthetic:true,productionOperatorsTested:false}));
 }finally{await worker.end();await api.end();await admin.end();}
});
