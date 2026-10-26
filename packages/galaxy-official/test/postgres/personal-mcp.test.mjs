import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { verifyPersonalMcp } from '../personal-mcp-workflow.mjs';

test('PostgreSQL API role runs independent OAuth and protected MCP with current binding, Consent and durable audit', {timeout:60000},async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),api=new pg.Pool({max:8,options:'-c role=galaxy_api',statement_timeout:10000});
  try {
    await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    console.log(JSON.stringify({event:'personal_mcp_postgres_verified',...await verifyPersonalMcp(api,{migrateDatabase:false,repositories:apiReads})}));
  }finally{await api.end();await admin.end();}
});
