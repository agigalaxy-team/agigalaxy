import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyDiscoveryV2 } from '../discovery-v2-workflow.mjs';
import { verifyChatOwnerMetadataExport } from '../chat-owner-export-workflow.mjs';

test('Discovery v2 HTTP and added chat owner export run under restricted PostgreSQL API role', {timeout:120000}, async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({options:'-c role=galaxy_api',statement_timeout:15000});
  try {
    await migrate(admin,{roles:['api']});
    await verifyDiscoveryV2(api,{migrateDatabase:false,repositories:apiReads});
    await verifyChatOwnerMetadataExport(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});
  } finally {await api.end();await admin.end();}
});
