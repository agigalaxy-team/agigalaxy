import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyHistoryWorkflow } from '../history-workflow.mjs';
import { verifyHistoryCollaboration } from '../history-collaboration-workflow.mjs';
import { verifyProfileWorkflow } from '../profile-workflow.mjs';
import { verifyHistoryPresentation } from '../history-presentation-workflow.mjs';
import { verifyEvidenceRevalidation } from '../evidence-revalidation-workflow.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { verifyHistorySearch } from '../history-search-workflow.mjs';
import { verifyTypedSearch } from '../typed-search-workflow.mjs';
test('isolated PostgreSQL restricted API rebuilds locked source histories and enforces current visibility',async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:10000});
  try{
    await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
    await verifyHistoryWorkflow(api,{migrateDatabase:false,repositories:apiReads});
    await verifyHistoryCollaboration(api,{migrateDatabase:false,repositories:apiReads});
    await verifyProfileWorkflow(api,{migrateDatabase:false,repositories:apiReads});
    await verifyHistoryPresentation(api,{migrateDatabase:false,repositories:apiReads});
    await verifyEvidenceRevalidation(api,{migrateDatabase:false,repositories:apiReads,workerReads,workerDb:worker});
    await verifyHistorySearch(api,{migrateDatabase:false,repositories:apiReads,workerReads,workerDb:worker});
    await verifyTypedSearch(api,{migrateDatabase:false,repositories:apiReads,workerReads,workerDb:worker});
  }finally{await worker.end();await api.end();await admin.end();}
});
