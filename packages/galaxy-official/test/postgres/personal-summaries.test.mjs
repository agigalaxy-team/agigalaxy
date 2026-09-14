import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {migrate} from '../../src/database.mjs';
import {verifySummaryWorkflow} from '../personal-summary-workflow.mjs';
test('actual PostgreSQL API role keeps both device versions and one prompt lease',{timeout:60000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const database=new pg.Pool({max:8,statement_timeout:10000}),runtimeDb=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
 try{await migrate(database);await database.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
  await verifySummaryWorkflow({database,runtimeDb,migrateDatabase:false});
  console.log(JSON.stringify({event:'personal_summary_actual_pg_verified',apiRole:true,concurrentConflict:true,concurrentPresentation:true,modelCalls:0,systemDeliveryVerified:false}));
 }finally{await runtimeDb.end();await database.end();}
});
