import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptStatusFixture } from './receipt-status-workflow.mjs';
import { createChoiceSyncClient } from '../../galaxy-web/src/choice-sync-client.mjs';

async function fixture() { const t = await receiptStatusFixture();
  // This service fixture has an explicit additional receipt-purpose authority;
  // the actual runtime must receive the same deployment pin, never a body key.
  t.f.bindings.trustedKeys.set('receipt-fixture', t.trustedKeys.get('receipt-fixture')); return t;
}

test('Local retained directory recovers the exact lost ACK after all sessions expire without ordinary API, source content or synchronization', async () => {
  const t = await fixture();
  try {
    t.setTime(t.policy.takeoutUntil + 1);
    assert.equal((await t.runtime.status()).connection, null);
    const start = t.requests.length, directory = await t.cloud.retainedReceiptOperations();
    assert.equal(t.requests.length, start, 'the local directory does not authenticate or contact the service');
    assert.equal(directory.length, 1); assert.deepEqual(directory[0], { snapshotId: t.operation.snapshotId, versionId: t.operation.versionId,
      requestHash: t.operation.requestHash, owner: { subjectId: t.identity.subjectId, endpoint: t.f.access.endpoint }, originalState: 'local-pending', location: 'pending' });
    assert.equal(JSON.stringify(directory).includes('Sensitive original'), false);
    const preferences = (await t.f.db.query('SELECT * FROM choice_snapshot_preferences ORDER BY subject_id')).rows;
    const result = await t.cloud.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId });
    assert.equal(result.state, 'acknowledged'); assert.equal(result.contentReturned, false); assert.equal(result.currentAccessGranted, false);
    assert.deepEqual(t.requests.slice(start).map(r => r.path), ['/v2/receipt-status/challenges', '/v2/receipt-status/query']);
    assert.deepEqual((await t.f.db.query('SELECT * FROM choice_snapshot_preferences ORDER BY subject_id')).rows, preferences);
    const next = await t.cloud.retainedReceiptOperations(); assert.equal(next.length, 1); assert.equal(next[0].location, 'receipt');
    assert.equal(next[0].originalState, 'acknowledged'); assert.equal(next[0].requestHash, t.operation.requestHash);
    const journal = await t.runtime.getLocal('choice-cloud-v2'); assert.equal(journal.pending[t.operation.snapshotId], undefined);
    assert.equal(journal.operationReceipts[t.operation.versionId].owner.subjectId, t.identity.subjectId);
    assert.equal(journal.heads[t.operation.snapshotId], undefined, 'original ACK never restores or reads the current cloud body/head');
  } finally { await t.close(); }
});

test('Retained stopped, absent and conflict operations remain read-only and never retry; an unknown local selection cannot query', async () => {
  const t = await fixture();
  try {
    const stopped = await t.cloud.discardPending(t.operation.snapshotId); assert.equal(stopped.localRetryStopped, true);
    t.setTime(t.policy.takeoutUntil + 1); let start = t.requests.length;
    const entries = await t.cloud.retainedReceiptOperations(); assert.equal(entries[0].location, 'stopped');
    assert.equal((await t.cloud.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId })).state, 'acknowledged');
    assert.equal(t.requests.slice(start).filter(r => r.path === '/v2/choice-snapshots/put').length, 0);
    await t.f.db.query('UPDATE choice_snapshot_versions SET request_hash=$2 WHERE version_id=$1', [t.operation.versionId, '0'.repeat(64)]);
    start = t.requests.length;
    assert.equal((await t.cloud.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId })).state, 'conflict');
    await t.f.db.query('DELETE FROM choice_snapshot_versions WHERE subject_id=$1', [t.identity.subjectId]);
    const absent = await t.cloud.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId });
    assert.equal(absent.state, 'absent'); assert.equal(absent.absenceMeaning, 'no-retained-owner-operation');
    assert.ok(t.requests.slice(start).every(r => r.path.startsWith('/v2/receipt-status/')));
    const count = t.requests.length;
    await assert.rejects(t.cloud.reconcileRetained(t.operation.snapshotId, { versionId: crypto.randomUUID() }), /choice_original_operation_missing/);
    assert.equal(t.requests.length, count); assert.equal((await t.cloud.retainedReceiptOperations()).length, 1);
  } finally { await t.close(); }
});

test('Retained local read, late HTTP, final local save and queued work are pinned to the actual runtime device/lifecycle', async () => {
  const t = await fixture();
  try {
    await t.runtime.disconnect(); let change = 'read', reads = 0, writes = 0;
    const facade = { ...t.runtime,
      getLocal: async name => { const result = await t.runtime.getLocal(name); reads++; if (change === 'read') { change = null; await t.runtime.disconnect(); } return result; },
      putLocal: async (name, value) => { writes++; await t.runtime.putLocal(name, value); if (change === 'write') { change = null; await t.runtime.disconnect(); } },
      receiptStatus: { ...t.runtime.receiptStatus, query: async (...args) => { const result = await t.runtime.receiptStatus.query(...args); if (change === 'http') { change = null; await t.runtime.disconnect(); } return result; } } };
    const client = createChoiceSyncClient(facade, { subjectId: t.identity.subjectId });
    const start = t.requests.length;
    await assert.rejects(client.retainedReceiptOperations(), /authority_changed/); assert.equal(t.requests.length, start); assert.equal(writes, 0);
    change = 'http'; await assert.rejects(client.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId }), /authority_changed/);
    assert.equal(writes, 0, 'late accepted metadata cannot clear a new lease journal');
    change = 'write'; await assert.rejects(client.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId }), /authority_changed/);
    assert.equal(writes, 1); const journal = await t.runtime.getLocal('choice-cloud-v2');
    assert.equal(journal.pending[t.operation.snapshotId], undefined, 'completed original local ACK save is retained, not falsely rolled back');
    assert.equal(journal.operationReceipts[t.operation.versionId].owner.subjectId, t.identity.subjectId);
    assert.equal((await client.retainedReceiptOperations())[0].location, 'receipt'); assert.ok(reads > 0);
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; }), begun = new Promise(resolve => { entered = resolve; });
    let block = true;
    const queued = createChoiceSyncClient({ ...t.runtime, getLocal: async name => { const value = await t.runtime.getLocal(name);
      if (block) { block = false; entered(); await blocked; } return value; } }, { subjectId: t.identity.subjectId });
    const first = queued.retainedReceiptOperations(); await begun; const second = queued.retainedReceiptOperations();
    await t.runtime.disconnect(); release();
    const settled = await Promise.allSettled([first, second]); assert.ok(settled.every(item => item.status === 'rejected' && /authority_changed/.test(item.reason.message)));
    client.close(); queued.close();
  } finally { await t.close(); }
});

test('Retained directory respects original owner/endpoint and never sends a foreign or modified journal locator', async () => {
  const t = await fixture();
  try {
    const journal = await t.runtime.getLocal('choice-cloud-v2');
    journal.pendingOwners[t.operation.versionId] = { subjectId: t.f.actor.subjectId, endpoint: t.f.access.endpoint };
    await t.runtime.putLocal('choice-cloud-v2', journal); const start = t.requests.length;
    await assert.rejects(t.cloud.retainedReceiptOperations(), /choice_original_owner_mismatch/);
    await assert.rejects(t.cloud.reconcileRetained(t.operation.snapshotId, { versionId: t.operation.versionId }), /choice_original_owner_mismatch/);
    assert.equal(t.requests.length, start);
    journal.pendingOwners[t.operation.versionId] = { subjectId: t.identity.subjectId, endpoint: 'https://other.example.org' };
    await t.runtime.putLocal('choice-cloud-v2', journal);
    await assert.rejects(t.cloud.retainedReceiptOperations(), /choice_original_owner_mismatch/); assert.equal(t.requests.length, start);
  } finally { await t.close(); }
});
