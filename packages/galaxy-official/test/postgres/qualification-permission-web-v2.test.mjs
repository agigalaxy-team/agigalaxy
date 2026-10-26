import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyQualificationPermissionWebV2} from '../qualification-permission-web-v2-workflow.mjs';
test('Qualification request actual PostgreSQL API/worker roles and signed browser workflow',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker'});
 try{await migrate(admin,{roles:['api','worker']});await verifyQualificationPermissionWebV2(api,{migrateDatabase:false,repositories:apiReads,adminDatabase:admin,workerDatabase:worker});}
 finally{await api.end();await worker.end();await admin.end();}
});
