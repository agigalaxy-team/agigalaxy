import test from 'node:test';
import assert from 'node:assert/strict';
import { buildersContinuityFixture } from './builders-client-continuity-workflow.mjs';
import { createBuildersWebClient } from "../../galaxy-web/src/features/builders/builders-client.mjs";
import { randomUUID } from 'node:crypto';
import { builderDeclaration } from './builders-workflow.mjs';

for (const phase of ['local-load', 'authorization-return']) test(
  `actual Builder consumer withholds old connection at ${phase} before business write`,
  { timeout: 60000 }, async () => {
    const f = await buildersContinuityFixture();
    try {
      if (phase === 'local-load') f.state.reconnectOnLoad = true;
      else f.state.reconnectAfterAuthorization = true;
      const original = f.api.snapshot();
      let rejection;
      try { await f.client.submit(f.event, { confirmed: true, visibility: 'Public' }); }
      catch (error) { rejection = error; }
      assert.equal(f.businessCalls(), 0);
      assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM builder_events WHERE id=$1', [f.event.id])).rows[0].n), 0);
      assert.match(rejection?.message ?? '', /身份|连接/);
      assert.notEqual(f.api.snapshot().generation, original.generation);
    } finally { await f.close(); }
  });

test('actual Builder pair read does not combine two connection leases', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    await f.client.submit(f.event, { confirmed: true, visibility: 'Private' });
    f.state.reconnectAfterRead = '/v1/builders/read';
    const before = f.calls.filter(path => path === '/v2/builders/support/read').length;
    await assert.rejects(f.client.read(f.event.builderId, true), /身份|连接/);
    assert.equal(f.calls.filter(path => path === '/v2/builders/support/read').length, before);
  } finally { await f.close(); }
});

test('actual lost Builder ACK reconciles the original ID/hash after reconnect without a second event', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    f.state.loseEventAck = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Public' }), /ACK lost/);
    const pending = (await f.client.local()).pending;
    await f.connect();
    const receipt = await f.client.reconcile({ retry: true, confirmed: true });
    assert.equal(receipt.state, 'acknowledged'); assert.equal(f.businessCalls(), 1);
    assert.equal(receipt.eventId, f.event.id); assert.equal(receipt.payloadHash, pending.payloadHash);
    assert.equal((await f.client.local()).pending, null);
    const row = (await f.f.db.query('SELECT payload_hash,payload_text FROM builder_events WHERE id=$1', [f.event.id])).rows[0];
    assert.equal(row.payload_hash, pending.payloadHash); assert.equal(row.payload_text, pending.payloadJson);
    assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM builder_events WHERE id=$1', [f.event.id])).rows[0].n), 1);
  } finally { await f.close(); }
});

test('Builder reconnect after accepted Consent keeps original business bytes and requires a current exact authorization preview', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    f.state.reconnectAfterAuthorization = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Private' }), /身份|连接/);
    const pending = (await f.client.local()).pending;
    assert.equal((await f.client.reconcile()).state, 'absent'); assert.equal(f.businessCalls(), 0);
    await assert.rejects(f.client.reconcile({ retry: true }), /确认/); assert.equal(f.businessCalls(), 0);
    assert.equal((await f.client.reconcile({ retry: true, confirmed: true })).reason, 'original-binding-changed');
    const preview = await f.client.reviewAuthorization();
    assert.equal(preview.state, 'reauthorization-required'); assert.deepEqual(preview.event, pending.event);
    assert.equal(preview.expiresAt, pending.authorizationExpiresAt);
    const receipt = await f.client.reauthorize(preview, { confirmed: true });
    assert.equal(receipt.eventId, f.event.id); assert.equal(f.businessCalls(), 1);
    assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM consents WHERE id=$1', [pending.prepared.intent.id])).rows[0].n), 1);
    const row = (await f.f.db.query('SELECT consent_id,payload_hash,payload_text FROM builder_events WHERE id=$1', [f.event.id])).rows[0];
    assert.notEqual(row.consent_id, pending.prepared.intent.id); assert.equal(row.payload_hash, pending.payloadHash);
    assert.equal(row.payload_text, pending.payloadJson);
  } finally { await f.close(); }
});

test('unavailable Builder receipt stops unknown retry while retaining the original body-free locator', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    f.state.loseEventAck = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Public' }), /ACK lost/);
    const pending = (await f.client.local()).pending; f.state.receiptUnavailable = true;
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true }), /receipt network/);
    const stop = await f.client.discard();
    assert.equal(stop.remoteState, 'unknown'); assert.equal(stop.remoteCancellationConfirmed, false);
    const local = await f.client.local();
    assert.equal(local.pending, null); assert.equal(local.stoppedOperations[0].payloadHash, pending.payloadHash);
    assert.equal(JSON.stringify(local).includes(pending.payloadJson), false); assert.equal(f.businessCalls(), 1);
    f.state.receiptUnavailable = false; await f.connect();
    assert.equal((await f.client.queryStopped(stop)).state, 'acknowledged'); assert.equal(f.businessCalls(), 1);
  } finally { await f.close(); }
});

for (const phase of ['save', 'accepted-event']) test(`Builder ${phase} completion on another lease preserves original journal`, { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    if (phase === 'save') f.state.reconnectOnSave = true;
    else f.state.reconnectAfterEvent = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Public' }), /身份|连接|Authorization changed/);
    const pending = (await f.client.local()).pending;
    assert.equal(pending.event.id, f.event.id); assert.equal(pending.event.builderId, f.event.builderId);
    assert.equal(f.businessCalls(), phase === 'save' ? 0 : 1);
    const receipt = await f.client.reconcile();
    assert.equal(receipt.state, phase === 'save' ? 'absent' : 'acknowledged');
    assert.equal(f.businessCalls(), phase === 'save' ? 0 : 1);
  } finally { await f.close(); }
});

test('absent Builder operation requires original preview after binding change; unknown Consent prevents new authorization', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    f.state.failConsentBeforeCommit = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Private' }), /Consent request failed/);
    const original = (await f.client.local()).pending; await f.connect();
    f.state.consentReceiptUnavailable = true;
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true }), /Consent receipt unavailable/);
    await assert.rejects(f.client.reviewAuthorization(), /Consent receipt unavailable/);
    assert.equal(f.businessCalls(), 0);
    assert.equal((await f.client.local()).pending.prepared.intent.id, original.prepared.intent.id);
    f.state.consentReceiptUnavailable = false;
    assert.equal((await f.client.resumePending()).reason, 'original-binding-changed');
    const preview = await f.client.reviewAuthorization();
    await f.client.reauthorize(preview, { confirmed: true });
    const row = (await f.f.db.query('SELECT consent_id,payload_text,payload_hash FROM builder_events WHERE id=$1', [f.event.id])).rows[0];
    assert.notEqual(row.consent_id, original.prepared.intent.id);
    assert.equal(row.payload_text, original.payloadJson); assert.equal(row.payload_hash, original.payloadHash);
    assert.equal(f.businessCalls(), 1);
    assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM consents WHERE id=$1', [original.prepared.intent.id])).rows[0].n), 0);
  } finally { await f.close(); }
});

test('Builder legacy journal migrates only its signed endpoint and retains original bytes for receipt recovery', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    f.state.loseEventAck = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Private' }), /ACK lost/);
    const key = 'builder-web-v2:' + f.api.endpoint + ':' + f.f.actor.subjectId,
      legacyKey = 'builder-web-v2:' + f.f.actor.subjectId, original = structuredClone(f.memory.get(key));
    f.memory.delete(key); f.memory.set(legacyKey, original);
    await f.connect();
    assert.equal((await f.client.reconcile()).state, 'acknowledged');
    assert.deepEqual(f.memory.get(legacyKey), original); assert.equal(f.memory.get(key).pending, null);
    assert.equal(f.businessCalls(), 1);
  } finally { await f.close(); }
});

test('Builder consumer captures queued intents even with a substitute API lacking inner request guards', async () => {
  const subjectId = 'GUID' + 'A'.repeat(28), bindingId = randomUUID(), endpoint = 'https://official.example.org';
  let generation = 1, release, started;
  const ready = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const api = { endpoint, snapshot: () => ({ subjectId, bindingId, generation }),
    call: async () => { throw Error('No network operation expected'); },
    prepareAuthorization: async () => { throw Error('No authorization expected'); } };
  let reads = 0;
  const client = createBuildersWebClient({ api, getLocal: async () => { reads++; started(); return blocked; },
    putLocal: async () => { throw Error('No local write expected'); } }, { subjectId });
  const local = client.local(), localRejected = assert.rejects(local, /身份|连接/); await ready;
  const submission = client.submit({ id: randomUUID(), builderId: randomUUID(), kind: 'declare', expectedRevision: 0,
    declaration: builderDeclaration('worker', subjectId) }, { confirmed: true });
  const submissionRejected = assert.rejects(submission, /身份|连接/);
  generation++; release(null); await Promise.all([localRejected, submissionRejected]); assert.equal(reads, 1);
});

test('Builder stopped absence remains queryable after delayed original acceptance and later normal work', { timeout: 60000 }, async () => {
  const f = await buildersContinuityFixture();
  try {
    f.state.reconnectAfterAuthorization = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true, visibility: 'Private' }), /身份|连接/);
    const original = (await f.client.local()).pending;
    const stopped = await f.client.discard(); assert.equal(stopped.remoteState, 'absent');
    assert.equal(stopped.remoteCancellationConfirmed, false);
    assert.equal((await f.client.queryStopped(stopped)).state, 'absent');
    const submission = await f.api.submitAuthorization(original.prepared, { confirmed: true, reconcile: true });
    await f.api.call('/v1/builders/events', submission);
    const next = { ...f.event, id: randomUUID(), builderId: randomUUID() };
    await f.client.submit(next, { confirmed: true, visibility: 'Private' });
    const ack = await f.client.queryStopped(stopped);
    assert.equal(ack.state, 'acknowledged'); assert.equal(ack.eventId, original.event.id);
    assert.equal(ack.payloadHash, original.payloadHash);
    const retained = (await f.client.local()).stoppedOperations;
    assert.equal(retained.length, 1); assert.equal(retained[0].endpoint, f.api.endpoint);
    assert.equal(retained[0].ownerId, f.f.actor.subjectId);
    assert.equal('payloadJson' in retained[0], false); assert.equal('prepared' in retained[0], false);
  } finally { await f.close(); }
});
