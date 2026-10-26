import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyPendingDeletionV2, verifyProductV2Deletion, verifyProductV2Retention } from '../lifecycle-v2-workflow.mjs';

test('product lifecycle on isolated PostgreSQL: API export, owner erasure and bounded Worker privileges', {timeout:120000}, async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),runtime=new pg.Pool({options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker',statement_timeout:15000});
  try{
    await migrate(admin);
    for(const role of ['api','worker'])await admin.query(await readFile(new URL(`../../src/infrastructure/${role}-role.sql`,import.meta.url),'utf8'));
    await verifyPendingDeletionV2(runtime,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});
    await verifyProductV2Deletion(admin,{migrateDatabase:false});
    await verifyProductV2Retention(admin,{migrateDatabase:false,workerDatabase:worker});
  }finally{await worker.end();await runtime.end();await admin.end();}
});
