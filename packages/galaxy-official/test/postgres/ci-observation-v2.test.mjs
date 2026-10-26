import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyCiV2} from '../ci-observation-v2-workflow.mjs';
test('Native CI v2 actual API and observer PostgreSQL roles plus signed HTTP flow',{timeout:60000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000}),worker=new pg.Pool({max:4,options:'-c role=galaxy_evidence_worker',statement_timeout:10000});
  try{await migrate(admin,{roles:['api','worker']});
    await assert.rejects(api.query('INSERT INTO ci_observations_v2 DEFAULT VALUES'),e=>e.code==='42501');
    await assert.rejects(worker.query("UPDATE cases SET state='withdrawn' WHERE false"),e=>e.code==='42501');
    await assert.rejects(worker.query('SELECT signed FROM ci_proofs_v2'),e=>e.code==='42501');
    await verifyCiV2(api,{workerDb:worker,migrateDatabase:false,repositories:apiReads,testHttp:true});
  }finally{await worker.end();await api.end();await admin.end();}
});
