import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {migrate} from "../../src/infrastructure/database.mjs";
import {apiReads} from '../../src/infrastructure/api-reads.mjs';
import {verifyTrustPermissions} from '../trust-package-permissions-workflow.mjs';
import {checkTrustLifecycle} from '../trust-package-lifecycle-check.mjs';
test('TrustPackage permission actual HTTP and restricted PostgreSQL role',{timeout:120000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:15000}),worker=new pg.Pool({options:'-c role=galaxy_evidence_worker'});
 try{await migrate(admin,{roles:['api','worker']});await verifyTrustPermissions({database:api,migrateDatabase:false,repositories:apiReads,
   extraScopes:['data-export','data-delete'],now:Math.floor(Date.now()/1000)-60,afterWorkflow:checkTrustLifecycle({admin,worker})});}
 finally{await api.end();await worker.end();await admin.end();}
});
