import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from '../../src/database.mjs';
import {verifyAttachments} from '../chat-attachments-workflow.mjs';
test('PostgreSQL API and worker roles operate private attachment orchestration without schema-owner bypass',{timeout:90000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const db=new pg.Pool({max:8}),runtimeDb=new pg.Pool({max:8,options:'-c role=galaxy_api'}),workerDb=new pg.Pool({max:3,options:'-c role=galaxy_evidence_worker'});
 try {await migrate(db);for(const role of ['api-role','worker-role'])await db.query(await readFile(new URL('../../src/infrastructure/'+role+'.sql',import.meta.url),'utf8'));
  console.log(JSON.stringify(await verifyAttachments({database:db,runtimeDb,workerDb,migrateDatabase:false})));
 }finally{await workerDb.end();await runtimeDb.end();await db.end();}
});
