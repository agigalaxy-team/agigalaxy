import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyDiscoveryLifecycleV2 } from '../discovery-lifecycle-v2-workflow.mjs';
test('M19 schema52–56 owner export, field-source erasure and bounded Contact expiry under PostgreSQL roles',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const admin=new pg.Pool(),api=new pg.Pool({options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:15000});
 try{await migrate(admin,{roles:['api']});await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
  await verifyDiscoveryLifecycleV2(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin,workerDatabase:worker});
 }finally{await worker.end();await api.end();await admin.end();}
});
