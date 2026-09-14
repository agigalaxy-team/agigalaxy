import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/database.mjs';
import { verifyRuntimeConfigWorkflow } from './runtime-config-workflow.mjs';
import { recordRuntimeConfig,runtimeConfigSnapshot } from '../src/operations/runtime-config-audit.mjs';
test('runtime config observation records role changes and archives only fixed metadata',async()=>{
  const db=new PGlite();try{await migrate(db);await verifyRuntimeConfigWorkflow(db);
    await db.exec("ALTER TABLE audit_events ADD CONSTRAINT synthetic_no_runtime CHECK(action<>'runtime.config.observe') NOT VALID");
    const before=Number((await db.query('SELECT count(*) FROM runtime_config_events')).rows[0].count);
    await assert.rejects(recordRuntimeConfig(db,{endpoint:'https://rollback.example.org',component:'worker',snapshot:runtimeConfigSnapshot({})}));
    assert.equal(Number((await db.query('SELECT count(*) FROM runtime_config_events')).rows[0].count),before);
  }finally{await db.close();}
});
