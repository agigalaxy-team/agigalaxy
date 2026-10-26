import test from 'node:test';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsRetention,createOperationsRetentionWorker} from '../src/operations-retention.mjs';
import {operationsProductFixture} from './operations-product-fixture.mjs';

async function archive(f,{expired=true}={}){
  const id=randomUUID(),at=new Date(f.now()*1000).toISOString(),selection={scopeId:randomUUID(),workspaceId:null,sessionIds:['synthetic-private-source']};
  await f.db.query(`INSERT INTO private_conversation_archives_v1(id,account_id,title,selection,state,byte_length,chunk_count,created_at,updated_at,expires_at)
    VALUES($1,$2,'PRIVATE TITLE NEVER IN AUDIT',$3,'ready',12,1,$4,$4,$5)`,[id,f.people[0].accountId,JSON.stringify(selection),at,new Date((f.now()+(expired?-1:3600))*1000).toISOString()]);
  await f.db.query(`INSERT INTO private_conversation_chunks_v1(archive_id,sequence,content,byte_length) VALUES($1,0,'private body',12)`,[id]);
  return id;
}

test('bounded retention removes only due copies and records the exact operator and actual cleanup result',{timeout:60000},async t=>{
  const f=await operationsProductFixture(t),retention=new OperationsRetention(f),worker=createOperationsRetentionWorker({retention});
  const live=await archive(f,{expired:false});for(let index=0;index<101;index++)await archive(f);
  const before=await retention.status(f.reader),target=before.targets.find(item=>item.key==='private-conversation-archives');
  assert.equal(target.backlog,101);assert.equal(target.observations.length,0,'no observation is not a claim that a scheduled worker has never run');
  const command={operationId:randomUUID(),target:'private-conversation-archives'};
  const requested=await retention.request(f.actor,command);
  assert.equal((await retention.request(f.actor,command)).replayed,true);
  assert.equal((await retention.get(f.reader,requested.run.id)).run.state,'queued');
  assert.deepEqual(await worker.execute({runId:requested.run.id}),{state:'completed',result:{privateConversationArchives:100}});
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_archives_v1')).rows[0].n,2);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_archives_v1 WHERE id=$1',[live])).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_deletions_v1')).rows[0].n,100);
  assert.equal((await worker.execute({runId:requested.run.id})).state,'completed','job replay cannot repeat a completed cleanup');
  const status=await retention.status(f.reader);assert.equal(status.targets.find(item=>item.key===command.target).backlog,1);
  const completed=(await f.businessAdmin.audit(f.reader)).items.find(item=>item.action==='retention-complete');
  assert.equal(completed.operatorId,f.actor.operatorId);assert.equal(completed.selection.execution,'worker');assert.equal(completed.result.counts.privateConversationArchives,100);
  assert.equal(JSON.stringify(await f.businessAdmin.audit(f.reader)).includes('PRIVATE TITLE'),false);
});

test('authority revocation, audit rollback and cross-process cancellation never erase private data',{timeout:60000},async t=>{
  const f=await operationsProductFixture(t),retention=new OperationsRetention(f),worker=createOperationsRetentionWorker({retention}),id=await archive(f);
  const requested=await retention.request(f.actor,{operationId:randomUUID(),target:'private-conversation-archives'});
  f.setRole('reader');await assert.rejects(worker.execute({runId:requested.run.id}),{code:'operations_permission_denied'});
  assert.equal((await retention.get(f.reader,requested.run.id)).run.errorCode,'operations_permission_denied');
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_archives_v1 WHERE id=$1',[id])).rows[0].n,1);
  f.setRole('administrator');const record=f.businessAdmin.recordWithin.bind(f.businessAdmin);
  f.businessAdmin.recordWithin=async function(db,actor,action,input){if(action==='retention-complete')throw Error('synthetic audit commit failure');return record.call(this,db,actor,action,input);};
  await assert.rejects(worker.execute({runId:requested.run.id}),{code:'retention_cleanup_failed'});
  f.businessAdmin.recordWithin=record;
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_chunks_v1 WHERE archive_id=$1',[id])).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_deletions_v1 WHERE archive_id=$1',[id])).rows[0].n,0,'erasure and its receipt both roll back with failed audit');
  const next=new OperationsRetention(f),newWorker=createOperationsRetentionWorker({retention:next});
  await f.jobs.cancel('retention-cleanup',requested.run.jobId,{endpoint:f.endpoint});
  assert.equal((await newWorker.execute({runId:requested.run.id})).state,'cancelled','API cancellation persists domain state used in another process');
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM private_conversation_archives_v1 WHERE id=$1',[id])).rows[0].n,1);
  await assert.rejects(retention.request(f.reader,{operationId:randomUUID(),target:'private-conversation-archives'}),{code:'operations_permission_denied'});
  const audit=await f.businessAdmin.audit(f.reader);assert.ok(audit.items.some(item=>item.action==='retention-failed'&&item.selection.reason==='authority_changed'));
});

test('retention audit keeps only fixed count metadata and closed authority reasons',()=>{
 const base={id:randomUUID(),sequence:1,operator_id:'retention-fixture',operator_role:'administrator',action:'retention-complete',created_at:new Date()};
 const row=businessAuditMetadata({...base,selection:{reason:'authority_changed',body:'PRIVATE_UNSELECTED'},result:{counts:{privateConversationArchives:100,objectKeys:'PRIVATE_UNSELECTED'},body:'PRIVATE_UNSELECTED'}});
 assert.deepEqual(row.selection,{reason:'authority_changed'});assert.deepEqual(row.result,{counts:{privateConversationArchives:100}});assert(!JSON.stringify(row).includes('PRIVATE_UNSELECTED'));
 const invalid=businessAuditMetadata({...base,selection:{reason:'PRIVATE_UNSELECTED'},result:{counts:{privateConversationArchives:'PRIVATE_UNSELECTED'}}});
 assert.deepEqual(invalid.selection,{});assert.deepEqual(invalid.result,{});
});
