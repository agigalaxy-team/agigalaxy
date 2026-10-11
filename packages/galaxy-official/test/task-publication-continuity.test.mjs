import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationFixture } from './task-publication-continuity-fixture.mjs';

test('task publication old confirmation stops at both pending read and persisted draft reconnect boundaries', { timeout: 60000 }, async () => {
  const f = await publicationFixture();
  try {
    for (const boundary of ['get', 'put']) {
      const before = f.runtime.api.snapshot(); let switched = false;
      f.hooks[boundary] = async key => {
        if (!switched && key.endsWith(':task-publication')) { switched = true; await f.reconnect(); }
      };
      await assert.rejects(f.runtime.publishTask(f.draft, { confirmed: true }), /身份或连接已改变/);
      f.hooks[boundary] = null;
      assert.ok(switched); assert.equal(f.runtime.api.snapshot().subjectId, before.subjectId);
      assert.notEqual(f.runtime.api.snapshot().bindingId, before.bindingId);
      assert.equal(f.counts.consents, 0); assert.equal(f.counts.publications, 0);
      const pending = await f.runtime.getLocal('task-publication');
      if (boundary === 'get') assert.equal(pending, undefined);
      else assert.ok(pending.payload.operationId && pending.payloadHash && !pending.preparedConsent);
    }
    const original = await f.runtime.getLocal('task-publication');
    assert.equal((await f.runtime.reconcilePublication()).state, 'absent');
    assert.equal(f.counts.consents, 0);
    const result = await f.runtime.reconcilePublication({ retry: true });
    assert.equal(result.taskId, original.payload.taskId); assert.equal(result.eventId, original.payload.operationId);
    assert.equal(f.counts.consents, 1); assert.equal(f.counts.publications, 1);
  } finally { await f.close(); }
});

test('task publication freezes confirmed input and serializes simultaneous publications into one original operation', { timeout: 60000 }, async () => {
  const f = await publicationFixture();
  try {
    let mutated = false;
    f.hooks.get = async key => {
      if (!mutated && key.endsWith(':task-publication')) {
        mutated = true; f.draft.title = 'Unconfirmed mutation'; f.draft.workContext.goal = 'Unconfirmed nested mutation';
      }
    };
    const results = await Promise.allSettled([f.runtime.publishTask(f.draft, { confirmed: true }), f.runtime.publishTask(f.draft, { confirmed: true })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'pending_task_publication').length, 1);
    assert.equal(f.counts.consents, 1); assert.equal(f.counts.publications, 1);
    const receipt = results.find(r => r.status === 'fulfilled').value;
    const task = await f.runtime.api.call('/v2/tasks/' + receipt.taskId, undefined, { method: 'GET' });
    assert.equal(task.request.title, 'Synthetic publication continuity');
    assert.equal(task.request.workContext.goal, 'Review synthetic continuity');
  } finally { await f.close(); }
});

test('accepted lost publication ACK and stale receipt read recover only the original operation without replay', { timeout: 60000 }, async () => {
  const f = await publicationFixture();
  try {
    f.hooks.loseAck = true;
    await assert.rejects(f.runtime.publishTask(f.draft, { confirmed: true }), /lost task publication ACK/);
    const original = await f.runtime.getLocal('task-publication');
    let switched = false;
    f.hooks.get = async key => { if (!switched && key.endsWith(':task-publication')) { switched = true; await f.reconnect(); } };
    await assert.rejects(f.runtime.reconcilePublication({ retry: true }), /身份或连接已改变/);
    assert.equal(f.counts.receipts, 0); f.hooks.get = null;
    const receipt = await f.runtime.reconcilePublication({ retry: true });
    assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.taskId, original.payload.taskId);
    assert.equal(receipt.eventId, original.payload.operationId); assert.equal(f.counts.consents, 1); assert.equal(f.counts.publications, 1);
  } finally { await f.close(); }
});

test('late ACK release reconnect preserves body-free original receipt coordinates after pending null persists', { timeout: 60000 }, async () => {
  const f = await publicationFixture(); let switched = false, original;
  try {
    f.hooks.put = async (key, value) => {
      if (key.endsWith(':task-publication') && value?.payload) original = structuredClone(value);
      if (!switched && key.endsWith(':task-publication') && value === null) { switched = true; await f.reconnect(); }
    };
    await assert.rejects(f.runtime.publishTask(f.draft, { confirmed: true }), /身份或连接已改变/);
    assert.ok(switched); f.hooks.put = null;
    assert.equal(await f.runtime.getLocal('task-publication'), null);
    const coordinates = await f.runtime.getLocal('task-publication-receipt');
    assert.deepEqual(Object.keys(coordinates).sort(), ['eventId', 'payloadHash', 'taskId']);
    assert.equal(coordinates.eventId, original.payload.operationId); assert.equal(coordinates.payloadHash, original.payloadHash);
    const receipt = await f.runtime.reconcilePublication({ retry: true });
    assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.taskId, original.payload.taskId);
    assert.equal(f.counts.consents, 1); assert.equal(f.counts.publications, 1);
  } finally { await f.close(); }
});
