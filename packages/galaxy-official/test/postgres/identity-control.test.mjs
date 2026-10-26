import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {migrate} from "../../src/infrastructure/database.mjs";
import {verifyIdentityControlLifecycle} from '../identity-control-workflow.mjs';

test('real PostgreSQL serializes identity recovery and denies stale transactional writers',{timeout:60000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const pool=new pg.Pool({max:8,statement_timeout:10000}),runtimeDb=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
  try{
    await migrate(pool);await pool.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    console.log(JSON.stringify({event:'identity_control_postgres_verified',apiRole:true,...await verifyIdentityControlLifecycle(pool,{migrateDatabase:false,runtimeDb})}));
  }finally{await runtimeDb.end();await pool.end();}
});
