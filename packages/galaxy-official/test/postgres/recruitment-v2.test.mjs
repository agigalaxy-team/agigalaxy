import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyRecruitmentV2 } from '../recruitment-v2-workflow.mjs';
test('Recruitment HTTP, real Account quota and independent data lifecycle under PostgreSQL API role',{timeout:150000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),api=new pg.Pool({options:'-c role=galaxy_api',statement_timeout:15000});
 try{await migrate(admin,{roles:['api']});await verifyRecruitmentV2(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin});}
 finally{await api.end();await admin.end();}
});
