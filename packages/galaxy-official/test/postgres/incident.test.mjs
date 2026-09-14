import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyIncidentNotices } from '../incident-notices-workflow.mjs';
test('isolated PostgreSQL delivers private incident notices while API role cannot impersonate operations',async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
  try{
    await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    await verifyIncidentNotices(api,{migrateDatabase:false,repositories:apiReads,operationsDb:admin});
    await assert.rejects(api.query("UPDATE incident_notices SET title='changed'"),/permission denied/);
    await assert.rejects(api.query('DELETE FROM incident_notices'),/permission denied/);
    await assert.rejects(api.query('INSERT INTO incident_notices SELECT * FROM incident_notices'),/permission denied/);
  }finally{await api.end();await admin.end();}
});
