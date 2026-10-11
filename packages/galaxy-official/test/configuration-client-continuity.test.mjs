import test from 'node:test';
import assert from 'node:assert/strict';
import { buildersContinuityFixture } from './builders-client-continuity-workflow.mjs';
import { configurationExample } from './configuration-v2-workflow.mjs';
import { createConfigurationClient } from '../../galaxy-web/src/configuration-client.mjs';

const clientFor = (f, api = f.runtime.api) => createConfigurationClient({ api,
  subjectId:f.f.actor.subjectId,now:()=>f.f.now,
  getLocal:f.runtime.getLocal,putLocal:f.runtime.putLocal });
const recordFor = f => ({...configurationExample(f.f.actor),observedAt:new Date(f.f.now*1000).toISOString()});
const writes = f => f.calls.filter(path=>path==='/v1/consents'||path==='/v2/configurations/events').length;

test('configuration keeps the exact confirmed journal before its draft callback and recovers a lost ACK read-only', {timeout:60000}, async()=>{
  const f=await buildersContinuityFixture();
  try {
    let lose=true;
    const api={...f.runtime.api,call:async(...args)=>{
      const value=await f.runtime.api.call(...args);
      if(lose&&args[0]==='/v2/configurations/events'){lose=false;throw Error('synthetic lost configuration ACK');}
      return value;
    }},client=clientFor(f,api),record=recordFor(f),preview=await client.prepare(record),before=writes(f);
    let locator;
    await assert.rejects(client.execute(preview,{confirmed:true,onJournal:async value=>{
      locator=value;
      const persisted=[...f.memory.values()].find(row=>row?.active?.operationId===record.operationId)?.active;
      assert.equal(persisted.payloadJson,preview.payloadJson);
      assert.equal(persisted.authorizationBindingId,api.snapshot().bindingId);
      assert.equal(writes(f),before,'draft linking happens before Consent or business dispatch');
    }}),/synthetic lost configuration ACK/);
    assert.equal(locator.operationId,record.operationId);assert.equal(locator.payloadHash,preview.payloadHash);
    assert.equal(Object.hasOwn(locator,'payloadJson'),false,'draft locator contains no source body or signed approval');
    const pending=await client.reviewPending(record.operationId);
    assert.equal(pending.payloadJson,preview.payloadJson);assert.equal(pending.visibility,'Private');
    const count=writes(f),fresh=clientFor(f);
    assert.equal((await fresh.resumePending()).state,'acknowledged');assert.equal(writes(f),count);
    assert.equal((await fresh.receiptFor(locator)).state,'acknowledged','exact receipt remains readable after journal settlement');
    assert.equal((await fresh.pending()).length,0);
    assert.equal((await fresh.get({id:record.id})).record.summary,record.summary);
  } finally { await f.close(); }
});

test('configuration replacement binding requires the exact original review token and never changes its content, audience or valid deadline', {timeout:60000}, async()=>{
  const f=await buildersContinuityFixture();
  try {
    const client=clientFor(f),record=recordFor(f),preview=await client.prepare(record);
    f.state.failConsentBeforeCommit=true;
    await assert.rejects(client.execute(preview,{confirmed:true}),/failed before commit/);
    const initial=await client.reviewPending(record.operationId);
    await f.connect();const before=writes(f);
    assert.equal((await client.resumePending()).reason,'original-binding-changed');assert.equal(writes(f),before);
    const original=await client.reviewPending(record.operationId),review=await client.reviewAuthorization(record.operationId);
    assert.equal(original.payloadJson,initial.payloadJson);assert.equal(original.payloadHash,initial.payloadHash);
    assert.equal(original.expiresAt,initial.expiresAt);assert.equal(review.expiresAt,initial.expiresAt);
    await assert.rejects(client.reauthorize(record.operationId,{...review,expiresAt:review.expiresAt+60},{confirmed:true}),/核对/);
    assert.equal(writes(f),before);
    review.viewers.push('GUID'+'A'.repeat(28));
    await assert.rejects(client.reauthorize(record.operationId,review,{confirmed:true}),/核对/);assert.equal(writes(f),before);
    const exact=await client.reviewAuthorization(record.operationId);
    assert.equal((await client.reauthorize(record.operationId,exact,{confirmed:true})).state,'acknowledged');
    const row=(await f.f.db.query('SELECT payload_text,payload_hash,consent_id FROM configuration_events WHERE operation_id=$1',[record.operationId])).rows[0];
    assert.equal(row.payload_text,initial.payloadJson);assert.equal(row.payload_hash,initial.payloadHash);
    const consent=(await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[row.consent_id])).rows[0].intent;
    assert.equal(consent.expiresAt,initial.expiresAt);assert.deepEqual(consent.viewers,initial.viewers);
    assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM configuration_events WHERE operation_id=$1',[record.operationId])).rows[0].n),1);
  } finally { await f.close(); }
});

test('configuration current-body reads withhold a completed prior binding result; failed local linking dispatches nothing', {timeout:60000}, async()=>{
  const f=await buildersContinuityFixture();
  try {
    const client=clientFor(f),record=recordFor(f),preview=await client.prepare(record),before=writes(f);
    await assert.rejects(client.execute(preview,{confirmed:true,onJournal:()=>{throw Error('synthetic draft locator unavailable');}}),/locator unavailable/);
    assert.equal(writes(f),before);assert.equal((await client.reviewPending(record.operationId)).payloadJson,preview.payloadJson);
    assert.equal((await client.resumePending()).state,'acknowledged');
    f.state.reconnectAfterRead='/v2/configurations/read';
    await assert.rejects(client.get({id:record.id}),/身份或连接已变化/);
    assert.equal((await clientFor(f).get({id:record.id})).record.title,record.title);
  } finally { await f.close(); }
});

test('a legacy millisecond deadline stays unchanged with zero automatic signing or writes until its exact original content is reviewed', {timeout:60000}, async()=>{
  const f=await buildersContinuityFixture();
  try {
    let preparations=0;
    const api={...f.runtime.api,prepareAuthorization:async(...args)=>{
      preparations++;return f.runtime.api.prepareAuthorization(...args);
    }},old=createConfigurationClient({api,subjectId:f.f.actor.subjectId,
      now:()=>f.f.now*1000,getLocal:f.runtime.getLocal,putLocal:f.runtime.putLocal}),
      record=recordFor(f),preview=await old.prepare(record),before=writes(f);
    await assert.rejects(old.execute(preview,{confirmed:true}),error=>error.code==='consent_policy_denied');
    const key=[...f.memory.keys()].find(key=>key.startsWith('configuration-operations:')),
      original=structuredClone(f.memory.get(key)),attempts=preparations;
    assert.equal(original.active.authorizationExpiresAt,f.f.now*1000+2591900);
    assert.equal(original.active.prepared,undefined);
    const client=clientFor(f,api);
    assert.equal((await client.resumePending()).reason,'authorization-deadline-invalid');
    assert.equal(preparations,attempts,'automatic resume never prepares or signs an impossible original deadline');
    assert.equal(writes(f),before);
    assert.deepEqual(f.memory.get(key),original,'automatic reading never rewrites the legacy journal');
    const details=await client.reviewPending(record.operationId),review=await client.reviewAuthorization(record.operationId);
    assert.equal(details.expiresAt,original.active.authorizationExpiresAt);
    assert.equal(review.originalExpiresAt,details.expiresAt);
    assert.equal(review.expiresAt,f.f.now+2591900);
    assert.equal(review.payloadJson,original.active.payloadJson);
    assert.equal(review.payloadHash,original.active.payloadHash);
    assert.equal(writes(f),before,'a read-only preview does not grant a replacement deadline');
    assert.equal((await client.reauthorize(record.operationId,review,{confirmed:true})).state,'acknowledged');
    const row=(await f.f.db.query('SELECT payload_text,payload_hash FROM configuration_events WHERE operation_id=$1',[record.operationId])).rows[0];
    assert.equal(row.payload_text,original.active.payloadJson);assert.equal(row.payload_hash,original.active.payloadHash);
    assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM configuration_events WHERE operation_id=$1',[record.operationId])).rows[0].n),1);
  } finally { await f.close(); }
});
