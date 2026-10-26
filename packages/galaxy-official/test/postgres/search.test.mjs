import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { verifyCapsuleWorkflow } from '../capsule-workflow.mjs';
import { verifyTypedSearch } from '../typed-search-workflow.mjs';
import { verifySearchIndex } from '../search-index-workflow.mjs';
import { verifyBuilderSearch } from '../builder-search-workflow.mjs';
import { verifyBuilderRecovery } from '../builder-recovery-workflow.mjs';
import { verifyNodeControlProofWorkflow } from '../node-control-proof-workflow.mjs';
import { verifyBuilderWorkEvidence } from '../builder-work-evidence-workflow.mjs';
import { verifyBuilderProbes } from '../builder-probes-workflow.mjs';
import { verifySearchWorker } from './search-worker-workflow.mjs';
import { verifyDeletionExecution } from '../deletion-execute-workflow.mjs';
test('isolated PostgreSQL limited roles preserve typed search and Capsule reuse visibility and final pages',async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:10000});
  try{
    await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
    await verifyCapsuleWorkflow(api,{migrateDatabase:false,repositories:apiReads,workerDatabase:worker});
    await verifyTypedSearch(api,{migrateDatabase:false,repositories:apiReads,workerReads,workerDb:worker});
    await verifySearchIndex(api,{migrateDatabase:false,repositories:apiReads,workerDb:worker});
    await verifyBuilderSearch(api,{migrateDatabase:false,repositories:apiReads,workerDb:worker});
    await verifyBuilderRecovery(api,{migrateDatabase:false,repositories:apiReads,workerDb:worker});
    await verifyNodeControlProofWorkflow(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});
    await verifyBuilderWorkEvidence(api,{migrateDatabase:false,repositories:apiReads,workerDatabase:worker});
    await verifyBuilderProbes(api,{migrateDatabase:false,repositories:apiReads,workerDatabase:worker,adminDatabase:admin});
    await verifyDeletionExecution(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});
    assert.deepEqual(await verifySearchWorker(),{actualWorker:true,restart:true,publicSearch:true,revokedSourceHidden:true,builderProbeRevocation:true});
  }finally{await worker.end();await api.end();await admin.end();}
});
