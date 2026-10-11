import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildersContinuityFixture} from './builders-client-continuity-workflow.mjs';
import {createBuildersWebClient} from '../../galaxy-web/src/builders-client.mjs';

const pendingKey=f=>'builder-web-v2:'+f.api.endpoint+':'+f.f.actor.subjectId;
const otherClient=f=>createBuildersWebClient(f.runtime,{subjectId:f.f.actor.subjectId,now:()=>f.f.now,locks:null});
const rows=async f=>Number((await f.f.db.query('SELECT count(*) AS n FROM builder_events WHERE id=$1',[f.event.id])).rows[0].n);

test('Builder journal locator is durable and awaited before any HTTP; automatic continuation keeps the original bytes and Consent', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  let selected,attached=false;const before=f.calls.length;f.state.failEventBeforeCommit=true;
  await assert.rejects(f.client.submit(f.event,{confirmed:true,visibility:'Private',onJournal:async locator=>{
   selected=locator;assert.equal(f.calls.length,before,'no HTTP before original journal association');
   const saved=f.memory.get(pendingKey(f)).pending;assert.equal(saved.event.id,locator.eventId);assert.equal(saved.payloadHash,locator.payloadHash);
   assert.deepEqual(Object.keys(locator).sort(),['endpoint','ownerId','builderId','eventId','payloadHash','kind'].sort());
   await Promise.resolve();attached=true;
  }}),/Builder request failed before commit/);
  assert.equal(attached,true);const original=(await f.client.local()).pending,consents=f.calls.filter(path=>path==='/v1/consents').length;
  const receipt=await f.client.resumePending();assert.equal(receipt.state,'acknowledged');assert.deepEqual(receipt.locator,selected);
  assert.equal(f.calls.filter(path=>path==='/v1/consents').length,consents,'same accepted permission, no new Consent');
  assert.equal(await rows(f),1);const row=(await f.f.db.query('SELECT payload_text,payload_hash,consent_id FROM builder_events WHERE id=$1',[f.event.id])).rows[0];
  assert.equal(row.payload_text,original.payloadJson);assert.equal(row.payload_hash,original.payloadHash);assert.equal(row.consent_id,original.prepared.intent.id);
  const reads=f.calls.length;assert.equal((await f.client.receiptFor(selected)).state,'acknowledged');
  assert.deepEqual(f.calls.slice(reads),['/v1/builders/events/receipt'],'receiptFor is an exact read only');
  await assert.rejects(f.client.receiptFor({...selected,ownerId:'GUID'+'A'.repeat(28)}),/不属于/);
 }finally{await f.close();}
});

test('independent Builder pages atomically retain one original operation and do not replace it', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  const second=otherClient(f),next={...f.event,id:randomUUID(),builderId:randomUUID()},journals=[];
  const settled=await Promise.allSettled([f.client.submit(f.event,{confirmed:true,onJournal:locator=>journals.push(locator)}),second.submit(next,{confirmed:true,onJournal:locator=>journals.push(locator)})]);
  assert.equal(settled.filter(item=>item.status==='fulfilled').length,1);
  const rejected=settled.find(item=>item.status==='rejected');assert.equal(rejected.reason.code,'builder_operation_pending');
  assert.equal(journals.length,1);assert.equal(f.businessCalls(),1);
  const saved=(await f.f.db.query('SELECT id,payload_hash FROM builder_events')).rows;assert.equal(saved.length,1);
  assert.equal(saved[0].id,journals[0].eventId);assert.equal(saved[0].payload_hash,journals[0].payloadHash);
 }finally{await f.close();}
});

test('stopping a Builder original from another page during journal association cannot revive or dispatch it', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  let open,release;const started=new Promise(resolve=>{open=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const submitting=f.client.submit(f.event,{confirmed:true,onJournal:async()=>{open();await waiting;}}),rejected=assert.rejects(submitting,error=>error.code==='builder_operation_changed');
  await started;const original=f.memory.get(pendingKey(f)).pending,second=otherClient(f),stopped=await second.discard();
  assert.equal(stopped.remoteState,'absent');release();await rejected;
  assert.equal(f.businessCalls(),0);assert.equal((await f.client.local()).pending,null);assert.equal(await rows(f),0);
  const retained=(await f.client.local()).stoppedOperations[0];assert.equal(retained.payloadHash,original.payloadHash);
  await assert.rejects(second.submit(f.event,{confirmed:true}),error=>error.code==='builder_operation_stopped');
  await second.submit({...f.event,id:randomUUID(),builderId:randomUUID()},{confirmed:true});
  assert.equal((await second.queryStopped(stopped)).state,'absent');assert.equal((await second.local()).stoppedOperations.length,1);
 }finally{await f.close();}
});

test('definite Builder revision rejection blocks automatic POST, while an explicit retry uses the same packet', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  await f.client.submit(f.event,{confirmed:true});
  f.event={...f.event,id:randomUUID(),declaration:{...f.event.declaration,name:'Stale synthetic declaration'}};
  await assert.rejects(f.client.submit(f.event,{confirmed:true}),error=>error.code==='builder_revision_conflict');
  const original=(await f.client.local()).pending;assert.equal(original.businessFailure.code,'builder_revision_conflict');assert.equal(original.businessFailure.status,409);
  const before=f.businessCalls();assert.equal((await f.client.resumePending()).reason,'business-declined');assert.equal((await otherClient(f).resumePending()).reason,'business-declined');assert.equal(f.businessCalls(),before);
  await assert.rejects(f.client.resumePending({explicitRetry:true}),error=>error.code==='builder_revision_conflict');
  assert.equal(f.businessCalls(),before+1);const current=(await f.client.local()).pending;assert.equal(current.payloadJson,original.payloadJson);assert.equal(current.submission.consentId,original.submission.consentId);assert.equal(await rows(f),0);
 }finally{await f.close();}
});

test('actual HTTP session loss is not a definite Builder business rejection', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  const original=f.runtime.api.submitAuthorization;f.runtime.api.submitAuthorization=async(...args)=>{const value=await original(...args);await f.f.db.query('UPDATE access_credentials SET revoked_at=$2 WHERE binding_id=$1',[f.api.snapshot().bindingId,new Date().toISOString()]);return value;};
  await assert.rejects(f.client.submit(f.event,{confirmed:true}),error=>error.code==='builder_authority_changed');
  assert.ok(f.state.responses.some(item=>item.path==='/v1/builders/events'&&item.status===401),'the real HTTP request lost its session');
  const saved=f.memory.get(pendingKey(f)).pending;assert.equal(saved.businessFailure,undefined);assert.notEqual(saved.blockedReason,'business-declined');assert.equal(await rows(f),0);
 }finally{await f.close();}
});

test('Builder original authorization preview stays stable across automatic polling and other pages, preserving the original deadline', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  f.state.reconnectAfterAuthorization=true;await assert.rejects(f.client.submit(f.event,{confirmed:true,visibility:'Private'}),/身份|连接/);
  const original=(await f.client.local()).pending,preview=await f.client.reviewAuthorization(),revision=(await f.client.local()).pending.journalRevision,consents=f.calls.filter(path=>path==='/v1/consents').length;
  for(let i=0;i<2;i++)assert.equal((await otherClient(f).resumePending()).reason,'original-binding-changed');
  assert.equal((await f.client.local()).pending.journalRevision,revision);assert.equal(f.calls.filter(path=>path==='/v1/consents').length,consents);
  await assert.rejects(f.client.reauthorize({...preview},{confirmed:true}),/查看并确认/);
  const ack=await f.client.reauthorize(preview,{confirmed:true});assert.equal(ack.state,'acknowledged');assert.equal(ack.eventId,original.event.id);
  const row=(await f.f.db.query('SELECT consent_id,payload_text FROM builder_events WHERE id=$1',[f.event.id])).rows[0];assert.equal(row.payload_text,original.payloadJson);
  const consent=(await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[row.consent_id])).rows[0];assert.equal(consent.intent.expiresAt,original.authorizationExpiresAt);
 }finally{await f.close();}
});

test('revoked Builder permission requires the exact original preview and never auto-extends its content scope', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  f.state.failEventBeforeCommit=true;await assert.rejects(f.client.submit(f.event,{confirmed:true,visibility:'Private'}),/Builder request failed/);
  const original=(await f.client.local()).pending;await f.f.consents.revoke(f.f.actor,original.prepared.intent.id);
  const before=f.businessCalls();assert.equal((await f.client.resumePending()).reason,'authorization-unavailable');assert.equal(f.businessCalls(),before);
  const preview=await f.client.reviewAuthorization();assert.equal(preview.expiresAt,original.authorizationExpiresAt);assert.equal(preview.visibility,'Private');assert.deepEqual(preview.viewers,[]);
  await assert.rejects(f.client.reauthorize(preview),/查看并确认/);assert.equal(f.businessCalls(),before);
  const ack=await f.client.reauthorize(preview,{confirmed:true});assert.equal(ack.state,'acknowledged');assert.equal(await rows(f),1);
  const row=(await f.f.db.query('SELECT payload_text,consent_id FROM builder_events WHERE id=$1',[f.event.id])).rows[0];assert.equal(row.payload_text,original.payloadJson);assert.notEqual(row.consent_id,original.prepared.intent.id);
 }finally{await f.close();}
});

test('a Builder permission revoked at the HTTP boundary remains an authorization issue rather than a business refusal',{timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  const submit=f.runtime.api.submitAuthorization;f.runtime.api.submitAuthorization=async(...args)=>{const value=await submit(...args);await f.f.consents.revoke(f.f.actor,value.consentId);return value;};
  await assert.rejects(f.client.submit(f.event,{confirmed:true}),error=>error.code==='consent_required'&&error.status===403);
  const original=(await f.client.local()).pending;assert.equal(original.businessFailure,undefined);
  const writes=f.businessCalls();assert.equal((await f.client.resumePending()).reason,'authorization-unavailable');assert.equal(f.businessCalls(),writes);
  const preview=await f.client.reviewAuthorization();assert.equal(preview.state,'reauthorization-required');assert.deepEqual(preview.event,original.event);assert.equal(preview.expiresAt,original.authorizationExpiresAt);
 }finally{await f.close();}
});

test('an absent legacy Builder package never bypasses explicit continuation and keeps the original signed bytes',{timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  f.state.failEventBeforeCommit=true;await assert.rejects(f.client.submit(f.event,{confirmed:true}),/Builder request failed/);
  const key=pendingKey(f),legacyKey='builder-web-v2:'+f.f.actor.subjectId,original=structuredClone(f.memory.get(key));
  for(const field of ['intentConfirmed','authorizationBindingId','authorizationExpiresAt','journalRevision'])delete original.pending[field];
  f.memory.delete(key);f.memory.set(legacyKey,original);const writes=f.businessCalls(),consents=f.calls.filter(path=>path==='/v1/consents').length;
  assert.equal((await f.client.resumePending()).reason,'legacy-explicit-retry-required');assert.equal(f.businessCalls(),writes);
  await assert.rejects(f.client.reconcile({retry:true}),/确认/);assert.equal(f.businessCalls(),writes);
  const ack=await f.client.reconcile({retry:true,confirmed:true});assert.equal(ack.state,'acknowledged');assert.equal(await rows(f),1);
  assert.deepEqual(f.memory.get(legacyKey),original);assert.equal(f.calls.filter(path=>path==='/v1/consents').length,consents);
  const row=(await f.f.db.query('SELECT payload_text,consent_id FROM builder_events WHERE id=$1',[f.event.id])).rows[0];assert.equal(row.payload_text,original.pending.payloadJson);assert.equal(row.consent_id,original.pending.prepared.intent.id);
 }finally{await f.close();}
});

test('expired Builder permission is proposed only in an explicit original-content preview, without a background signature', {timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  let clock=f.f.now-2591800;const client=createBuildersWebClient(f.runtime,{subjectId:f.f.actor.subjectId,now:()=>clock,locks:null});
  f.state.failEventBeforeCommit=true;await assert.rejects(client.submit(f.event,{confirmed:true}),/Builder request failed/);const original=(await client.local()).pending;
  clock=original.authorizationExpiresAt+1;const consents=f.calls.filter(path=>path==='/v1/consents').length,writes=f.businessCalls();assert.equal((await client.resumePending()).reason,'authorization-expired');
  const preview=await client.reviewAuthorization();assert.equal(preview.originalExpiresAt,original.authorizationExpiresAt);assert.equal(preview.expiresAt,clock+2591900);assert.deepEqual(preview.event,original.event);
  assert.equal(f.calls.filter(path=>path==='/v1/consents').length,consents);assert.equal(f.businessCalls(),writes);
 }finally{await f.close();}
});

for(const keepChanging of [false,true])test(`Builder entry/support reads ${keepChanging?'stop after a second concurrent update':'retry one coherent current version'} without mixing revisions`,{timeout:60000},async()=>{
 const f=await buildersContinuityFixture();try{
  await f.client.submit(f.event,{confirmed:true,visibility:'Public'});const call=f.runtime.api.call;let changes=0;
  f.runtime.api.call=async(...args)=>{const value=await call(...args);if(args[0]==='/v1/builders/read'&&(keepChanging||changes===0)){
   changes++;const event={id:randomUUID(),builderId:f.event.builderId,expectedRevision:value.revision,kind:'maintenance',declarationId:value.declarationId,action:'correction',summary:'Synthetic concurrent metadata update '+changes};
   const submission=await f.api.authorizePayload(event,{action:'builder.publish',objectId:event.id,visibility:'Public',confirmed:true});await f.api.call('/v1/builders/events',submission);
  }return value;};
  if(keepChanging){await assert.rejects(f.client.read(f.event.builderId,true),error=>error.code==='builder_current_changed');assert.equal(changes,2);}
  else{const current=await f.client.read(f.event.builderId,true);assert.equal(current.entry.revision,2);assert.equal(current.entry.revision,current.extensions.revision);assert.equal(current.entry.declarationHash,current.extensions.declarationHash);assert.equal(changes,1);}
 }finally{await f.close();}
});
