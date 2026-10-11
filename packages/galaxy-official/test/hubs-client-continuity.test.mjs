import test from 'node:test';
import assert from 'node:assert/strict';
import { hubsContinuityFixture } from './hubs-client-continuity-workflow.mjs';
import { createHubsWebClient } from '../../galaxy-web/src/hubs-client.mjs';
import { randomUUID } from 'node:crypto';

for (const phase of ['local-load', 'authorization-return']) test(
  `actual Hub consumer rejects old lease at ${phase} before event dispatch`, { timeout: 60000 }, async () => {
    const f = await hubsContinuityFixture();
    try {
      if (phase === 'local-load') f.state.reconnectOnLoad = true;
      else f.state.reconnectAfterAuthorization = true;
      let failure;
      try { await f.client.submit(f.event, { confirmed: true }); } catch (error) { failure = error; }
      assert.equal(f.hubBusinessCalls(), 0);
      assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM hub_events_v2 WHERE id=$1', [f.event.id])).rows[0].n), 0);
      assert.match(failure?.message ?? '', /身份|连接/);
    } finally { await f.close(); }
  });

test('actual private Hub management result is withheld after same-subject rebind', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    await f.client.submit(f.event, { confirmed: true });
    f.hubState.reconnectAfterCall = '/v2/hubs/manage';
    await assert.rejects(f.client.manage({ hubId: f.event.hubId }), /身份|连接/);
  } finally { await f.close(); }
});

test('unknown Hub receipt stops local retry but retains a body-free original locator', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    f.hubState.loseAck = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true }), /ACK lost/);
    const original = (await f.client.local()).pending;
    f.hubState.receiptState = 'unknown';
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true }), /回执|确定/);
    const stopped = await f.client.discard(), local = await f.client.local();
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.remoteState, 'unknown');
    assert.equal(stopped.remoteCancellationConfirmed, false);
    assert.deepEqual(local.stoppedOperations[0], { endpoint: f.api.endpoint, ownerId: f.f.actor.subjectId,
      operationId: f.event.id, hubId: f.event.hubId,
      payloadHash: original.payloadHash, family: 'hub' });
    assert.equal(local.pending, null); assert.equal(JSON.stringify(local).includes(original.payloadJson), false);
    assert.equal(f.hubBusinessCalls(), 1);
    f.hubState.receiptState = null; await f.connect();
    assert.equal((await f.client.reconcile({ retry: true, confirmed: true })).state, 'recorded');
    assert.equal(f.hubBusinessCalls(), 1);
  } finally { await f.close(); }
});

test('lost signed Hub and peering ACKs recover only original ID/hash after reconnect', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    for (const family of ['hub', 'peering']) {
      const event = family === 'hub' ? f.event : await f.approval();
      f.hubState.loseAck = true;
      await assert.rejects(f.client.submit(event, { family, confirmed: true }), /ACK lost/);
      const original = (await f.client.local()).pending, count = f.hubBusinessCalls();
      await f.connect();
      const ack = await f.client.reconcile({ retry: true, confirmed: true });
      assert.equal(ack.state, 'recorded'); assert.equal(ack.operationId, event.id);
      assert.equal(ack.payloadHash, original.payloadHash); assert.equal(f.hubBusinessCalls(), count);
      const table = family === 'hub' ? 'hub_events_v2' : 'hub_peering_events_v2';
      const row = (await f.f.db.query('SELECT payload_text,payload_hash FROM ' + table + ' WHERE id=$1', [event.id])).rows[0];
      assert.equal(row.payload_text, original.payloadJson); assert.equal(row.payload_hash, original.payloadHash);
    }
    assert.equal(f.hubBusinessCalls(), 2);
  } finally { await f.close(); }
});

test('absent Hub retry requires exact original preview on the current connection', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    f.hubState.failBeforeCommit = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true }), /before commit/);
    const original = (await f.client.local()).pending;
    assert.equal((await f.client.reconcile()).state, 'absent');
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true }), /阅读/);
    const oldReview = await f.client.reviewPending(); await f.connect();
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true, review: oldReview }), /身份|连接/);
    const review = await f.client.reviewPending();
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true, review: structuredClone(review) }), /阅读/);
    const hash = review.payloadHash; review.payloadHash = '0'.repeat(64);
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true, review }), /阅读/);
    review.payloadHash = hash;
    assert.equal((await f.client.reconcile({ retry: true, confirmed: true, review })).reason, 'binding-changed');
    const authorization = await f.client.reviewAuthorization();
    assert.equal(authorization.originalExpiresAt, original.prepared.intent.expiresAt);
    assert.equal(authorization.expiresAt, original.prepared.intent.expiresAt);
    const ack = await f.client.reauthorize(authorization, { confirmed: true });
    assert.equal(ack.operationId, original.event.id); assert.equal(ack.payloadHash, original.payloadHash);
    const row = (await f.f.db.query('SELECT consent_id,payload_text FROM hub_events_v2 WHERE id=$1', [original.event.id])).rows[0];
    assert.notEqual(row.consent_id, original.submission.consentId); assert.equal(row.payload_text, original.payloadJson);
    assert.equal(f.hubBusinessCalls(), 2); // one pre-commit failure and one explicit retry
  } finally { await f.close(); }
});

test('Hub local-save and receipt completion rebind preserve the original journal', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    f.state.reconnectOnSave = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true }), /身份|连接/);
    let original = (await f.client.local()).pending;
    assert.equal(original.event.id, f.event.id); assert.equal(f.hubBusinessCalls(), 0);
    const review = await f.client.reviewAuthorization();
    f.hubState.loseAck = true;
    await assert.rejects(f.client.reauthorize(review, { confirmed: true }), /ACK lost/);
    original = (await f.client.local()).pending;
    f.hubState.reconnectAfterCall = '/v2/hubs/receipt';
    await assert.rejects(f.client.reconcile(), /身份|连接/);
    assert.equal((await f.client.local()).pending.payloadHash, original.payloadHash);
    assert.equal((await f.client.reconcile()).state, 'recorded'); assert.equal(f.hubBusinessCalls(), 1);
  } finally { await f.close(); }
});

test('private peering party response is withheld after rebind', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    await f.client.submit(f.event, { confirmed: true });
    f.hubState.reconnectAfterCall = '/v2/hubs/peering/party';
    await assert.rejects(f.client.peering('party', { hubId: f.event.hubId }), /身份|连接/);
  } finally { await f.close(); }
});

test('absent Hub stop retains locator and never becomes an automatic retry', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    f.hubState.failBeforeCommit = true;
    await assert.rejects(f.client.submit(f.event, { confirmed: true }), /before commit/);
    const original = (await f.client.local()).pending;
    const stopped = await f.client.discard();
    assert.equal(stopped.remoteState, 'absent'); assert.equal(stopped.remoteCancellationConfirmed, false);
    await assert.rejects(f.client.reconcile({ retry: true, confirmed: true }), /停止/);
    // A delayed original acceptance remains discoverable; absence did not
    // authorize deletion of the locator or imply a server-side cancellation.
    await f.api.call('/v2/hubs/events', original.submission);
    const ack = await f.client.reconcile(); assert.equal(ack.operationId, original.event.id);
    assert.equal(ack.payloadHash, original.payloadHash);
    assert.equal((await f.client.local()).pending, null);
    const next = { ...f.event, id: randomUUID(), expectedVersion: 1 };
    await f.client.submit(next, { confirmed: true });
    const oldAck = await f.client.queryStopped(stopped);
    assert.equal(oldAck.operationId, original.event.id); assert.equal(oldAck.payloadHash, original.payloadHash);
    assert.equal((await f.client.local()).stoppedOperations.length, 1);
  } finally { await f.close(); }
});

test('Hub legacy recovery retains signed endpoint and exact original bytes', { timeout: 60000 }, async () => {
  const f = await hubsContinuityFixture();
  try {
    f.hubState.loseAck = true; await assert.rejects(f.client.submit(f.event, { confirmed: true }), /ACK lost/);
    const key = 'hubs-v2:' + f.api.endpoint + ':' + f.f.actor.subjectId,
      legacyKey = 'hubs-v2:' + f.f.actor.subjectId, original = structuredClone(f.memory.get(key));
    f.memory.delete(key); f.memory.set(legacyKey, original); await f.connect();
    assert.equal((await f.client.reconcile()).state, 'recorded');
    assert.deepEqual(f.memory.get(legacyKey), original); assert.equal(f.hubBusinessCalls(), 1);
  } finally { await f.close(); }
});

test('Hub queue captures the submitting lease before waiting for local storage', async () => {
  const subjectId = 'GUID' + 'A'.repeat(28), endpoint = 'https://official.example.org', bindingId = randomUUID();
  let generation = 1, start, release, reads = 0;
  const ready = new Promise(resolve => { start = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const api = { endpoint, snapshot: () => ({ subjectId, bindingId, generation }),
    call: async () => { throw Error('No business operation expected'); } };
  const client = createHubsWebClient({ api, getLocal: async () => { reads++; start(); return blocked; },
    putLocal: async () => { throw Error('No local write expected'); } }, { subjectId });
  const first = client.local(), firstRejected = assert.rejects(first, /身份|连接/); await ready;
  const next = client.submit({}, { confirmed: true }), nextRejected = assert.rejects(next, /身份|连接/);
  generation++; release(null); await Promise.all([firstRejected, nextRejected]); assert.equal(reads, 1);
});
