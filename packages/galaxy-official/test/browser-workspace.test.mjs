import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createRecoveryMaterial } from '../../galaxy-core/src/domain/identity-material.mjs';
import { retainTaskContactAgent } from '../../galaxy-web/test/task-contact-agent-fixture.mjs';

function localStore() {
  const values = new Map();
  const get = async key => structuredClone(values.get(key)), put = async (key, value) => { values.set(key, structuredClone(value)); };
  return { get, put, async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);return structuredClone(committed);}, async prepareRecovery(subjectId, operationId) { const key = `pending-recovery:${subjectId}:${operationId}`;
    let value = await get(key); if (!value) { value = { ...await createRecoveryMaterial(subjectId), operationId }; await put(key, value); } return value; },
    async declareSaved(subjectId, operationId) { const key = `pending-recovery:${subjectId}:${operationId}`; await put(key, { ...await get(key), saveDeclared: true }); },
    async recordReceipt(subjectId, operationId, receipt) { const key = `pending-recovery:${subjectId}:${operationId}`; await put(key, { ...await get(key), receipt }); } };
}

test('lost Consent before receipt requires explicit reauthorization after reconnect, keeping the original task operation', async () => {
  const websiteOrigin = 'https://galaxy.example.org', f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  const api = createApi({ ...f, browserOrigins: [websiteOrigin], rateLimit: 1000 });
  let runtime, dropConsent = false, dropTask = false;
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const local = `http://127.0.0.1:${api.address().port}`, config = { endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys };
    const store = localStore(), fetcher = async (url, options) => {
      const path = new URL(url).pathname;
      if (dropConsent && path === '/v1/consents') { dropConsent = false; throw new Error('connection lost before consent'); }
      const response = await fetch(local + path, { ...options, headers: { ...options.headers, Origin: websiteOrigin } });
      if (dropTask && path === '/v2/tasks') { dropTask = false; assert.equal(response.status, 200); throw new Error('task committed but receipt lost'); }
      return response;
    };
    runtime = await createWebRuntime(config, { store, fetch: fetcher, now: () => f.now, website:websiteOrigin });
    await runtime.createIdentity({ confirmed: true }); await runtime.connect({ confirmed: true });
    await retainTaskContactAgent(runtime,store,f.now);
    dropConsent = true;
    await assert.rejects(runtime.publishTask({ title: '恢复原发布', summary: '相同的主动任务', intent: 'collaboration',
      workContext: { goal: '保留原操作', currentSituation: '尚未尝试', attemptRefs: [] }, visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 86400 }, { confirmed: true }), /before consent/);
    const original = await runtime.getLocal('task-publication');
    assert.equal((await runtime.reviewTaskAuthorization()).state, 'retry-original');
    await runtime.disconnect(); await runtime.connect({ confirmed: true });
    await assert.rejects(runtime.reconcilePublication({ retry: true }), /consent_reauthorization_required/);
    assert.deepEqual(await runtime.getLocal('task-publication'), original);
    const preview = await runtime.reviewTaskAuthorization(); assert.equal(preview.state, 'reauthorization-required');
    await assert.rejects(runtime.reauthorizeTaskOperation(preview), /确认/);
    await assert.rejects(runtime.reauthorizeTaskOperation({ ...preview, payloadHash: 'changed' }, { confirmed: true }), /改变/);
    dropTask = true;
    await assert.rejects(runtime.reauthorizeTaskOperation(preview, { confirmed: true }), /task committed/);
    const pending = await runtime.getLocal('task-publication');
    assert.equal(pending.payload.operationId, original.payload.operationId); assert.equal(pending.payload.taskId, original.payload.taskId);
    assert.equal(pending.authorizationHistory.length, 1);
    assert.deepEqual(pending.authorizationHistory[0].preparedConsent, original.preparedConsent);
    assert.notEqual(pending.preparedConsent.intent.id, original.preparedConsent.intent.id);
    const receipt = await runtime.reviewTaskAuthorization(); assert.equal(receipt.state, 'acknowledged');
    assert.equal(await runtime.getLocal('task-publication'), null);
    assert.equal((await runtime.api.call(`/v2/tasks/${receipt.taskId}`, null, { method: 'GET' })).version, 1);
  } finally { runtime?.close(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});
test('browser workspace creates real device identity, reconnects, publishes without a failure Case and restores lost task receipt', async () => {
  const websiteOrigin = 'https://galaxy.example.org';
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) }), api = createApi({ ...f, browserOrigins: [websiteOrigin], rateLimit: 1000 });
  let runtime, recovered, participant; const transmissions = []; let dropTask = false, dropEvent = false, dropDeclaration = false;
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const local = `http://127.0.0.1:${api.address().port}`, config = { endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys };
    const fetcher = async (url, options) => { assert.equal(new URL(url).origin, config.endpoint); transmissions.push(options.body ?? '');
      const response = await fetch(local + new URL(url).pathname, { ...options, headers: { ...options.headers, Origin: websiteOrigin } });
      assert.equal(response.headers.get('access-control-allow-origin'), websiteOrigin);
      if (dropTask && new URL(url).pathname === '/v2/tasks') { dropTask = false; assert.equal(response.status, 200); throw new Error('lost acknowledgement'); }
      if (dropEvent && /\/v2\/tasks\/.+\/events$/.test(new URL(url).pathname)) { dropEvent = false; assert.equal(response.status, 200); throw new Error('lost event acknowledgement'); }
      if (dropDeclaration && new URL(url).pathname === '/v2/identity/control/commit') { dropDeclaration = false; assert.equal(response.status, 200); throw new Error('lost declaration acknowledgement'); }
      return response; };
    const store = localStore(); runtime = await createWebRuntime(config, { store, fetch: fetcher, now: () => f.now, website:websiteOrigin });
    const allowed = await fetch(local + '/v2/tasks', { method: 'OPTIONS', headers: { Origin: websiteOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
    const denied = await fetch(local + '/v2/tasks', { headers: { Origin: 'https://galaxy.example.org.evil.example' } });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    await assert.rejects(runtime.createIdentity(), /确认/);
    const created = await runtime.createIdentity({ confirmed: true });
    assert.ok(created.identity.subjectId.startsWith('GUID')); assert.equal(created.connection, null);
    await runtime.connect({ confirmed: true }); assert.equal((await runtime.status()).connection.subjectId, created.identity.subjectId);
    await retainTaskContactAgent(runtime,store,f.now);
    const draft = { title: '新参与者的主动评审', summary: '检查接口职责', intent: 'proactive-review', workContext: { goal: '明确接口边界', currentSituation: '尚未实施，无失败记录', attemptRefs: [] },
      visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 86400 };
    dropTask = true; await assert.rejects(runtime.publishTask(draft, { confirmed: true }), /lost acknowledgement/);
    runtime.close(); runtime = await createWebRuntime(config, { store, fetch: fetcher, now: () => f.now, website:websiteOrigin });
    await runtime.connect({ confirmed: true });
    const receipt = await runtime.reconcilePublication(); assert.equal(receipt.state, 'acknowledged');
    const task = await runtime.api.call(`/v2/tasks/${receipt.taskId}`, null, { method: 'GET' }); assert.equal(task.caseId, null);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM cases WHERE subject_id=$1', [created.identity.subjectId])).rows[0].n, 0);
    const participantStore=localStore();participant = await createWebRuntime(config, { store: participantStore, fetch: fetcher, now: () => f.now, website:websiteOrigin });
    await participant.createIdentity({ confirmed: true }); await participant.connect({ confirmed: true });
    await retainTaskContactAgent(participant,participantStore,f.now);
    const providerId = (await participant.status()).identity.subjectId;
    dropEvent = true;
    await assert.rejects(participant.taskEvent(task.taskId, { kind: 'apply', expectedTaskVersion: task.version, proposal: '新专家提供诊断', scope: '共同检查接口职责，不虚构失败' },
      { viewers: [task.requesterId], confirmed: true }), /lost event acknowledgement/);
    assert.equal((await participant.reconcileTaskEvent(task.taskId)).state, 'acknowledged');
    const applied = await runtime.api.call(`/v2/tasks/${task.taskId}`, null, { method: 'GET' });
    assert.equal(applied.contacts.responses.applications.length, 1);
    const proposal = await runtime.proposeParticipation(task.taskId, { expectedTaskVersion: applied.version, subjectId: providerId, role: 'diagnosis', agreedScope: '检查接口职责', applicationId: applied.contacts.responses.applications[0].applicationId }, { confirmed: true });
    await participant.participationEvent(task.taskId, proposal.participationId, { expectedParticipationVersion: 1, kind: 'confirm', scopeVersion: 1 }, { confirmed: true, viewers: [task.requesterId, providerId] });
    const cooperating = await runtime.api.call(`/v2/tasks/${task.taskId}`, null, { method: 'GET' });
    assert.equal(cooperating.participations[0].state, 'active'); assert.equal(cooperating.caseId, null);
    const recovery = await runtime.prepareRecovery(); assert.ok(recovery.code.startsWith('galaxy-recovery-v1:'));
    await runtime.saveRecovery({ operationId: recovery.operationId, confirmed: true });
    assert.equal(JSON.stringify(await store.get(`pending-recovery:${created.identity.subjectId}:${recovery.operationId}`)).includes(recovery.code), false);
    recovered = await createWebRuntime(config, { store: localStore(), fetch: fetcher, now: () => f.now, website:websiteOrigin });
    const restored = await recovered.recover(recovery.code, { confirmed: true });
    assert.equal(restored.identity.subjectId, created.identity.subjectId); assert.notEqual(restored.replacementCode, recovery.code);
    assert.equal((await recovered.pendingRecoveryCode()).code, restored.replacementCode);
    dropDeclaration = true; await assert.rejects(recovered.confirmRecoveredCode({ operationId: restored.operationId, confirmed: true }), /lost declaration acknowledgement/);
    await recovered.confirmRecoveredCode({ operationId: restored.operationId, confirmed: true }); assert.equal(await recovered.pendingRecoveryCode(), null); await recovered.connect({ confirmed: true });
    await assert.rejects(runtime.connect({ confirmed: true }), /失效/);
    assert.equal(transmissions.some(body => /PRIVATE KEY|galaxy-recovery-v1:/.test(body)), false);
  } finally { runtime?.close(); recovered?.close(); participant?.close(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});
