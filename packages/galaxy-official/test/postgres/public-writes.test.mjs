import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { migrate } from '../../src/database.mjs';
import { verifyPublicWrites } from '../public-writes-workflow.mjs';

test('real PostgreSQL serializes public writes across account GUIDs and independent connections', {timeout:60000}, async () => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const db = new pg.Pool({max:8}), runtimeDb = new pg.Pool({max:8, options:'-c role=galaxy_api'});
  try {
    await migrate(db); await db.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    console.log(JSON.stringify({event:'account_quota_postgres_verified',apiRole:true,...await verifyPublicWrites(db,{migrateDatabase:false,runtimeDb})}));
  } finally { await runtimeDb.end(); await db.end(); }
});
