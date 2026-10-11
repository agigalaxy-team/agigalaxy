import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture, verifyNativeWorkerPack } from './native-worker-pack-flow-workflow.mjs';

test('native Worker: physical store/device, signed Pack registration, MCP review, child execution/cancel, independent Result/use and exact ACK after restart', async t => {
  const observed = await verifyNativeWorkerPack(); assert.equal(observed.starts, 4);
  assert.equal(observed.shutdown.exitCode, 0); t.diagnostic('native_worker_pack_observed ' + JSON.stringify(observed));
});

test('native Worker actual reconnection fences local/queued/old preview and late peer output; original remote association survives', async t => {
  const x = await nativeWorkerFixture();
  try {
    const input = { ...await x.fact('原NativeFS连接代次检查'), text: JSON.stringify({ operation: 'sum', values: [9, 10] }) };
    let release, entered;
    const gate = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
    x.setStoreHook(async (kind, key) => { if (kind === 'get' && key.includes('worker-pack-host-v2:')) {
      x.setStoreHook(null); entered(); await gate; } });
    const { action: _action, ...flowInput } = input;
    const waiting = x.flow.associations(); await reached;
    const queued = x.flow.prepareStart(flowInput); await x.runtime.connect({ confirmed: true }); release();
    await Promise.all([assert.rejects(waiting, /authority_changed|connection changed/), assert.rejects(queued, /connection changed/)]);
    assert.equal((await x.processWorker.observations()).starts, 0);
    const old = await x.prepare(input); await x.runtime.connect({ confirmed: true });
    const stale = await x.raw('galaxy_worker_host_execute', { handle: old.handle, previewHash: old.previewHash });
    assert.equal(stale.isError, true); assert.equal((await x.processWorker.observations()).starts, 0);
    const beforeRead = x.requests.length;
    x.setHttpHook(async path => { if (path === '/v2/cases/' + input.caseId + '/read') {
      x.setHttpHook(null); await x.runtime.connect({ confirmed: true }); } });
    const lateRead = await x.raw('galaxy_worker_host_prepare', input);
    assert.equal(lateRead.isError, true); assert.equal(JSON.parse(lateRead.content[0].text).privateResultWithheld, true);
    assert.equal(x.requests.slice(beforeRead).filter(v => v === '/v2/cases/' + input.caseId + '/read').length, 1);
    assert.equal((await x.processWorker.observations()).starts, 0, 'completed old HTTP read cannot continue into a new-generation dispatch');
    const fresh = await x.prepare(input);
    x.processWorker.state.afterResponse = () => x.runtime.connect({ confirmed: true });
    const late = await x.chooseRaw(fresh); assert.equal(late.isError, true);
    assert.equal(JSON.parse(late.content[0].text).privateResultWithheld, true);
    assert.equal((await x.processWorker.observations()).starts, 1);
    await x.restart();
    const rows = await x.flow.associations(); assert.equal(rows.length, 1);
    assert.equal((await x.flow.read(rows[0].associationId)).peer.peer.state, 'completed');
    await assert.rejects(x.flow.prepareStart(flowInput), /already dispatched/);
    assert.equal(x.processWorker.requests.filter(v => v === 'SendMessage').length, 1);
    assert.equal(x.result.outerApiCalls, 0);
    t.diagnostic('native_worker_binding_observed ' + JSON.stringify({ nativeFS: true, queueAndLocalAwaitWithheld: true,
      oldPreviewWithheld: true, actualHttpLateReadWithheld: true, latePeerPrivateResultWithheld: true,
      actualOriginalStarts: 1, originalAssociationSurvivedRestart: true }));
  } finally { await x.close(); }
});

test('native Result signed Consent ACK saved to original filesystem during reconnect; late completion sends zero Result and resumes only exact original intent', async t => {
  const x = await nativeWorkerFixture();
  try {
    const start = await x.prepare({ ...await x.fact('Result授权落盘后重绑'), text: JSON.stringify({ operation: 'sum', values: [2, 3] }) });
    await x.choose(start);
    const preview = await x.prepare({ action: 'result', associationId: start.associationId, summary: '准确原输出5', reportedOutcome: 'succeeded' });
    x.setStoreHook(async (kind, key, value) => { if (kind === 'put' && key.includes('result-authorization:') && value.state === 'active') {
      x.setStoreHook(null); await x.runtime.connect({ confirmed: true }); } });
    const result = await x.chooseRaw(preview); assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).privateResultWithheld, true);
    assert.equal(Number((await x.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 0);
    const original = (await x.flow.read(start.associationId)).peer.resultImportV2.authorization;
    const saved = await x.runtime.store.get('native-worker-pack:' + x.config.endpoint + ':' + x.subjectId + ':result-authorization:' + original.requestId);
    assert.equal(saved.state, 'active'); assert.equal(saved.owner, x.subjectId); assert.equal(saved.input.payloadJson, original.payloadJson);
    const fresh = await x.prepare({ action: 'result', associationId: start.associationId, summary: '准确原输出5', reportedOutcome: 'succeeded' });
    await x.choose(fresh);
    assert.equal(Number((await x.f.db.query("SELECT count(*) FROM case_events WHERE kind='result-recorded'")).rows[0].count), 1);
    assert.equal((await x.flow.read(start.associationId)).peer.resultImportV2.authorization.requestId, original.requestId);
    const matches = await x.f.db.query('SELECT count(*) FROM consents WHERE id=$1', [original.requestId]); assert.equal(Number(matches.rows[0].count), 1);
    t.diagnostic('native_worker_authorization_observed ' + JSON.stringify({ originalConsentPersisted: true,
      lateResultBusinessCalls: 0, explicitCurrentReviewReusedOriginalRequest: true, consentRows: 1, resultRows: 1 }));
  } finally { await x.close(); }
});

test('native Worker no ordinary binding never auto-connects; model confirmation and non-Result intent are rejected', async () => {
  const x = await nativeWorkerFixture();
  try {
    const before = x.requests.length; await x.runtime.disconnect(); const start = x.requests.length;
    const response = await x.raw('galaxy_worker_host_read', { action: 'list' }); assert.equal(response.isError, true);
    await assert.rejects(x.adapter.runtime.api.call('/v1/builders/query', {}), /connection_required/);
    assert.equal(x.requests.length, start); assert.ok(start >= before); assert.equal(x.runtime.api.snapshot(), null);
    await x.runtime.connect({ confirmed: true });
    const invalid = await x.raw('galaxy_worker_host_execute', { handle: crypto.randomUUID(), previewHash: 'a'.repeat(64), confirmed: true });
    assert.equal(invalid.isError, true);
    await assert.rejects(x.adapter.runtime.authorize({ requestId: crypto.randomUUID(), action: 'builder.publish', objectId: crypto.randomUUID(),
      payloadJson: '{}', visibility: 'Private', viewers: [] }, { confirmed: true }));
    assert.equal((await x.processWorker.observations()).starts, 0); assert.equal(x.result.outerApiCalls, 0);
  } finally { await x.close(); }
});
