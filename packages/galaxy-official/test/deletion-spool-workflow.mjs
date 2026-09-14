import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceFixture } from './service-fixture.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
import { createFailureAuditSpool } from '../src/infrastructure/failure-audit-spool.mjs';
import { httpFailureWriter } from '../src/infrastructure/http-failure-audit.mjs';

export async function verifyDeletionSpool(database=null,options={}){
  const f=await serviceFixture(['binding','data-delete'],database,options),admin=options.adminDatabase??f.db;
  const directory=await mkdtemp(join(tmpdir(),'galaxy-deletion-spool-'));let spool;
  try{
    const command=await approveFixtureDeletion(f,admin,{auditUntil:f.now+60});
    const partial=await executeDeletion(admin,command,{now:()=>f.now});
    const event={requestId:randomUUID(),status:500,route:'POST /v1/cases',actor:f.actor,observedAt:new Date(f.now*1000).toISOString()};
    await httpFailureWriter(f.db,f.access.endpoint,{now:()=>f.now})(event);
    assert.equal((await f.db.query('SELECT sequence FROM audit_events WHERE http_request_id=$1',[event.requestId])).rows.length,1);
    const path=join(directory,'pending.sqlite');
    spool=await createFailureAuditSpool({path,endpoint:f.access.endpoint,intervalMs:60000,write:async()=>{throw new Error('synthetic outage');}});
    const pending={...event,requestId:randomUUID()};assert.equal(await spool.record(pending),'queued');await spool.flush();assert.equal(spool.status().pending,1);await spool.close();
    await executeDeletion(admin,{...command,id:randomUUID(),expectedRevision:partial.revision},{now:()=>f.now+60});
    spool=await createFailureAuditSpool({path,endpoint:f.access.endpoint,intervalMs:60000,write:httpFailureWriter(f.db,f.access.endpoint,{now:()=>f.now+60})});
    await spool.flush();assert.equal(spool.status().pending,0);assert.equal(spool.status().delivery,'suppressed-by-deletion');
    assert.equal((await f.db.query('SELECT sequence FROM audit_events WHERE actor=$1',[f.actor.subjectId])).rows.length,0);
    assert.equal((await f.db.query('SELECT id FROM subjects WHERE id=$1',[f.actor.subjectId])).rows.length,0);
    return {retainedUntilPolicy:true,lateAuditSuppressed:true,spoolDrained:true};
  }finally{await spool?.close();await rm(directory,{recursive:true,force:true});if(!database)await f.db.close();}
}
