import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hubsContinuityFixture} from './hubs-client-continuity-workflow.mjs';
import {createHubsWebClient} from '../../galaxy-web/src/hubs-client.mjs';

test('Hub journal locator is durably attached before HTTP, then the exact unsubmitted content resumes', {timeout:60000}, async()=>{
 const f=await hubsContinuityFixture();try{
  let selected;
  await assert.rejects(f.client.submit(f.event,{confirmed:true,onJournal:async locator=>{
   selected=locator;const saved=(await f.runtime.getLocal('hubs-v2:'+f.api.endpoint+':'+f.f.actor.subjectId)).pending;
   assert.equal(saved.event.id,locator.operationId);assert.equal(saved.payloadHash,locator.payloadHash);
   assert.equal(f.hubBusinessCalls(),0);assert.equal(f.calls.filter(path=>path==='/v1/consents').length,1);
   throw Error('Synthetic input revision changed before attachment');
  }}),/input revision changed/);
  assert.equal((await f.client.receiptFor(selected)).state,'absent');
  const acknowledged=await f.client.resumePending();assert.equal(acknowledged.state,'acknowledged');
  assert.deepEqual(acknowledged.locator,selected);assert.equal(f.hubBusinessCalls(),1);
  assert.equal((await f.client.local()).pending,null);
 }finally{await f.close();}
});

test('two Hub pages cannot replace an original operation while its input attachment is in flight', {timeout:60000}, async()=>{
 const f=await hubsContinuityFixture();try{
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  // Exercise the atomic store on hosts without a shared Web Lock manager.
  const firstClient=createHubsWebClient(f.runtime,{subjectId:f.f.actor.subjectId,now:()=>f.f.now,locks:null});
  const second=createHubsWebClient(f.runtime,{subjectId:f.f.actor.subjectId,now:()=>f.f.now,locks:null});
  const first=firstClient.submit(f.event,{confirmed:true,onJournal:async()=>{enter();await hold;}});await entered;
  await assert.rejects(second.submit({...f.event,id:randomUUID()},{confirmed:true}),caught=>caught.code==='hub_operation_pending');
  release();assert.equal((await first).state,'acknowledged');assert.equal(f.hubBusinessCalls(),1);
  assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM hub_events_v2')).rows[0].n),1);
 }finally{await f.close();}
});

test('real Hub version rejection blocks automatic POST; explicit retry preserves exact bytes', {timeout:60000}, async()=>{
 const f=await hubsContinuityFixture();try{
  await f.client.submit(f.event,{confirmed:true});
  const conflict={...f.event,id:randomUUID(),expectedVersion:2};
  await assert.rejects(f.client.submit(conflict,{confirmed:true}),caught=>caught.code==='hub_version_conflict'&&caught.status===409);
  const original=(await f.client.local()).pending,count=f.hubBusinessCalls();
  for(let i=0;i<3;i++)assert.equal((await f.client.resumePending()).reason,'business-declined');
  assert.equal(f.hubBusinessCalls(),count);assert.deepEqual((await f.client.local()).pending,original);
  await assert.rejects(f.client.resumePending({explicitRetry:true}),caught=>caught.code==='hub_version_conflict');
  assert.equal(f.hubBusinessCalls(),count+1);
  const after=(await f.client.local()).pending;assert.equal(after.payloadJson,original.payloadJson);
  assert.equal(after.prepared.signedIntent,original.prepared.signedIntent);assert.equal(after.submission.consentId,original.submission.consentId);
 }finally{await f.close();}
});

test('Hub background reads keep a binding-change review stable and do not silently extend authorization', {timeout:60000}, async()=>{
 const f=await hubsContinuityFixture();try{
  f.hubState.failBeforeCommit=true;await assert.rejects(f.client.submit(f.event,{confirmed:true}),/before commit/);
  const original=(await f.client.local()).pending;await f.connect();
  const preview=await f.client.reviewAuthorization(),reviewed=(await f.client.local()).pending;
  assert.equal(preview.reason,'binding-changed');assert.equal(preview.expiresAt,original.authorizationExpiresAt);
  for(let i=0;i<3;i++)assert.equal((await f.client.resumePending()).reason,'binding-changed');
  assert.deepEqual((await f.client.local()).pending,reviewed);
  assert.equal((await f.client.reauthorize(preview,{confirmed:true})).state,'acknowledged');
  const row=(await f.f.db.query('SELECT payload_text FROM hub_events_v2 WHERE id=$1',[f.event.id])).rows[0];
  assert.equal(row.payload_text,original.payloadJson);
 }finally{await f.close();}
});

test('unknown original Consent cannot create a new authorization; expired deadline needs an explicit accurate preview', {timeout:60000}, async()=>{
 const f=await hubsContinuityFixture();try{
  f.hubState.failBeforeCommit=true;await assert.rejects(f.client.submit(f.event,{confirmed:true}),/before commit/);
  const original=(await f.client.local()).pending,consents=f.calls.filter(path=>path==='/v1/consents').length,count=f.hubBusinessCalls();
  f.state.consentReceiptUnavailable=true;
  assert.equal((await f.client.resumePending()).reason,'consent-outcome-unknown');
  assert.equal((await f.client.reviewAuthorization()).state,'blocked');
  assert.equal(f.calls.filter(path=>path==='/v1/consents').length,consents);assert.equal(f.hubBusinessCalls(),count);
  f.state.consentReceiptUnavailable=false;
  // Only the consumer clock crosses the deadline; retain the independently
  // established HTTP session so this checks its authorization-date boundary.
  const clockClient=createHubsWebClient(f.runtime,{subjectId:f.f.actor.subjectId,now:()=>original.authorizationExpiresAt+1});
  const preview=await clockClient.reviewAuthorization();assert.equal(preview.reason,'permission-expired');
  assert.equal(preview.originalExpiresAt,original.authorizationExpiresAt);assert.ok(preview.expiresAt>preview.originalExpiresAt);
  assert.equal((await f.client.local()).pending.authorizationExpiresAt,original.authorizationExpiresAt);
  assert.equal(f.hubBusinessCalls(),count);
 }finally{await f.close();}
});

test('an absent legacy Hub packet requires its existing explicit review and preserves the old journal', {timeout:60000}, async()=>{
 const f=await hubsContinuityFixture();try{
  f.hubState.failBeforeCommit=true;await assert.rejects(f.client.submit(f.event,{confirmed:true}),/before commit/);
  const key='hubs-v2:'+f.api.endpoint+':'+f.f.actor.subjectId,legacyKey='hubs-v2:'+f.f.actor.subjectId,original=structuredClone(f.memory.get(key));
  f.memory.set(legacyKey,original);f.memory.delete(key);
  assert.equal((await f.client.resumePending()).reason,'legacy-review-required');assert.equal(f.hubBusinessCalls(),1);
  const preview=await f.client.reviewPending();assert.equal((await f.client.reconcile({retry:true,confirmed:true,review:preview})).state,'recorded');
  assert.deepEqual(f.memory.get(legacyKey),original);assert.equal(f.hubBusinessCalls(),2);
  const row=(await f.f.db.query('SELECT payload_text FROM hub_events_v2 WHERE id=$1',[f.event.id])).rows[0];assert.equal(row.payload_text,original.pending.payloadJson);
 }finally{await f.close();}
});
