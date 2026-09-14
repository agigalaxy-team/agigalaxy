import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runtimeConfigSnapshot,recordRuntimeConfig,exportRuntimeConfigPage,verifyRuntimeConfigEvent } from '../src/operations/runtime-config-audit.mjs';

export async function verifyRuntimeConfigWorkflow(db){
  const endpoint='https://config-'+randomUUID()+'.example.org',operatorRef='synthetic-operator';
  const first={id:randomUUID(),endpoint,operatorRef,component:'api',snapshot:runtimeConfigSnapshot({governance:{auditReaderIds:['GUID'+'0'.repeat(28)]}})};
  const a=await recordRuntimeConfig(db,first);assert.equal(a.payload.attribution,'runtime-provided-operator-reference');
  assert.equal((await recordRuntimeConfig(db,first)).event_hash,a.event_hash);
  await assert.rejects(recordRuntimeConfig(db,{...first,operatorRef:'different'}),/conflict/);
  const second={...first,id:randomUUID(),snapshot:runtimeConfigSnapshot({governance:{auditReaderIds:['GUID'+'1'.repeat(28)]},retirement:{version:1,id:'synthetic',endpoint,operator:'Synthetic operator',reason:'Synthetic sensitive free text',announcedAt:1,stopWritesAt:2,takeoutUntil:3,statusUntil:4,contactUrl:endpoint+'/contact',deletionPolicyUrl:endpoint+'/deletion'}})};
  const b=await recordRuntimeConfig(db,second);
  assert.equal(b.payload.previousHash,a.event_hash);
  assert.deepEqual(b.payload.changes.roles.auditReaderIds,{added:['GUID'+'1'.repeat(28)],removed:['GUID'+'0'.repeat(28)]});
  assert.ok(!JSON.stringify(b).includes('Synthetic sensitive free text'));
  const p1=await exportRuntimeConfigPage(db,{endpoint,component:'api',limit:1});assert.equal(p1.hasMore,true);assert.equal(p1.events.length,1);
  const p2=await exportRuntimeConfigPage(db,{endpoint,component:'api',after:p1.nextCursor,limit:1});assert.equal(p2.hasMore,false);assert.equal(p2.previousHash,p1.lastHash);
  assert.throws(()=>verifyRuntimeConfigEvent({...b,payload:{...b.payload,operatorRef:'tampered'}}),/mismatch/);
  const count=(await db.query("SELECT count(*) FROM audit_events WHERE action='runtime.config.observe' AND audience=$1",[endpoint])).rows[0].count;assert.equal(Number(count),2);
  await assert.rejects(recordRuntimeConfig(db,{...second,id:randomUUID(),snapshot:{...second.snapshot,rawSecret:'synthetic'}}));
  return {roleDiff:true,exactLoadedSnapshot:true,freeTextOmitted:true,idempotent:true,paginatedArchive:true,auditJoined:true};
}
