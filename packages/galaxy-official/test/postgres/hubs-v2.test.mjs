import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate} from '../../src/database.mjs';
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {peeringWorkflow} from '../hub-peering-workflow.mjs';
import {cleanupHubsWithin} from '../../src/operations/hub-retention-v2.mjs';
import {lockDeletionTables} from '../../src/operations/deletion-execute.mjs';
import {transaction} from '../../src/database.mjs';
import {checkHubLifecycle} from '../hub-lifecycle-check.mjs';
test('Hub and direct peering use restricted PG API role, actual HTTP and worker lifecycle',{timeout:120000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker'});
  try{await migrate(admin,{roles:['api','worker']});await peeringWorkflow(api,{migrateDatabase:false,repositories:apiReads,afterWorkflow:checkHubLifecycle({admin,repositories:apiReads})});
    await transaction(admin,db=>lockDeletionTables(db));
    const cleaned=await transaction(worker,db=>cleanupHubsWithin(db,Math.floor(Date.now()/1000)+181*86400));assert.equal(typeof cleaned.hubQueryReceipts,'number');
  }finally{await api.end();await worker.end();await admin.end();}
});
