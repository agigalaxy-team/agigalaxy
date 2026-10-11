import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReferenceWorkerProcess, referenceWorkerProcessFixture } from './worker-pack-process-v2-workflow.mjs';

test('fixed actual reference process: signed Pack choice, success/failure/cancel, separately accepted Result/use and exact lost ACK', async t => {
  const result = await verifyReferenceWorkerProcess();
  assert.equal(result.starts, 4); assert.equal(result.modelExecuted, false);
  t.diagnostic('reference_worker_process_observed ' + JSON.stringify(result));
});

test('Worker composition captures enqueue/local/network generation; late real peer acceptance is retained without returning old private output', async t => {
  const x = await referenceWorkerProcessFixture();
  try {
    const input = { ...await x.fact('检查旧连接不会启动或显示原私有结果'), text: JSON.stringify({ operation: 'sum', values: [9, 10] }) };
    const originalLoad = x.runtime.getLocal;
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let block = true;
    x.runtime.getLocal = async key => { const value = await originalLoad(key);
      if (block) { block = false; entered(); await gate; } return value; };
    const waiting = x.flow.associations(); await reached;
    const queued = x.flow.prepareStart(input); await x.f.connect(); release();
    await Promise.all([assert.rejects(waiting, /connection changed/), assert.rejects(queued, /connection changed/)]);
    x.runtime.getLocal = originalLoad;
    assert.equal((await x.processWorker.observations()).starts, 0, 'a queued old lease cannot send after the first await');
    x.f.state.reconnectOnLoad = true;
    await assert.rejects(x.flow.associations(), /connection changed/);
    assert.equal((await x.processWorker.observations()).starts, 0);
    const oldPreview = await x.flow.prepareStart(input); await x.f.connect();
    await assert.rejects(x.flow.execute(oldPreview, { confirmed: true }), /connection changed/);
    assert.equal((await x.processWorker.observations()).starts, 0);
    const current = await x.flow.prepareStart(input);
    x.processWorker.state.afterResponse = () => x.f.connect();
    await assert.rejects(x.flow.execute(current, { confirmed: true }), /connection changed/);
    assert.equal((await x.processWorker.observations()).starts, 1, 'a rejected late return is not a remote rollback');
    const stored = await x.flow.associations(); assert.equal(stored.length, 1);
    const oldAssociation = await x.flow.read(stored[0].associationId);
    assert.equal(oldAssociation.peer.status, 'observed'); assert.equal(oldAssociation.peer.peer.state, 'completed');
    await assert.rejects(x.flow.prepareStart(input), /already dispatched/);
    assert.equal(x.processWorker.requests.filter(method => method === 'SendMessage').length, 1);
    t.diagnostic('reference_worker_connection_observed ' + JSON.stringify({ queueWithheld: true, localAwaitWithheld: true,
      oldPreviewWithheld: true, peerLateReturnWithheld: true, actualPeerStarts: 1, originalAssociationRetained: true }));
  } finally { await x.close(); }
});
