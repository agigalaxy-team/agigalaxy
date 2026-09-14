import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate} from '../../src/database.mjs';
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyConfigurationV2} from '../configuration-v2-workflow.mjs';
test('Configuration actual PostgreSQL API role and cross-module source removal',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000});
 try{await migrate(admin,{roles:['api']});await verifyConfigurationV2(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});
  await assert.rejects(api.query("UPDATE configuration_events SET payload_text=''"),/permission denied/);
 }finally{await api.end();await admin.end();}
});
