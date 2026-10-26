import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyProjectsV2 } from '../projects-v2-workflow.mjs';
import { verifyContactsV2 } from '../contacts-v2-workflow.mjs';
test('Project and Contact HTTP flows use restricted PostgreSQL role with real local OIDC',{timeout:150000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const admin=new pg.Pool(),api=new pg.Pool({options:'-c role=galaxy_api',statement_timeout:15000});
 try{await migrate(admin,{roles:['api']});await verifyProjectsV2(api,{migrateDatabase:false,repositories:apiReads});
  await verifyContactsV2(api,{migrateDatabase:false,repositories:apiReads});
 }finally{await api.end();await admin.end();}
});
