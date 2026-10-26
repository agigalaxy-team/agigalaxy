import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyChoiceSnapshots} from '../choice-snapshots-v2-workflow.mjs';
test('Choice cloud actual PostgreSQL galaxy_api + HTTP, conflicts, source recheck and lifecycle deletion',{timeout:90000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),runtime=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
 try{await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
  await verifyChoiceSnapshots(runtime,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});
 }finally{await runtime.end();await admin.end();}
});
