import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifySearchV2} from '../search-v2-workflow.mjs';
test('Search v2 actual PostgreSQL limited API role and HTTP permission/current-source workflow',{timeout:90000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),runtime=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
  try{await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    await verifySearchV2(runtime,{migrateDatabase:false,repositories:apiReads});
  }finally{await runtime.end();await admin.end();}
});
