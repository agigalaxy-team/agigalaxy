import test from 'node:test';
import assert from 'node:assert/strict';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

function localStore() {
  const values = new Map();
  return {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    async update(key, change) {
      const next = change(structuredClone(values.get(key)));
      if (next && typeof next.then === 'function') {
        if (next instanceof Promise) void next.catch(() => {});
        throw Error('local_update_async_callback');
      }
      const committed = structuredClone(next);
      values.set(key, committed);
      return structuredClone(committed);
    },
  };
}

test('lost Consent before receipt requires explicit reauthorization after reconnect, keeping the original task operation', async () => {
  const websiteOrigin = 'https://galaxy.example.org', f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  const api = createApi({ ...f, browserOrigins: [websiteOrigin], rateLimit: 1000 });
  let runtime, dropConsent = false, dropTask = false;
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const local = `http://127.0.0.1:${api.address().port}`, config = { endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys };
    const preflight = await fetch(local + '/v2/tasks', { method: 'OPTIONS', headers: {
      Origin: websiteOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const denied = await fetch(local + '/v2/tasks', { headers: { Origin: websiteOrigin + '.evil.example' } });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const store = localStore(), fetcher = async (url, options) => {
      const path = new URL(url).pathname;
      if (dropConsent && path === '/v1/consents') { dropConsent = false; throw new Error('connection lost before consent'); }
      const response = await fetch(local + path, { ...options, headers: { ...options.headers, Origin: websiteOrigin } });
      if (dropTask && path === '/v2/tasks') { dropTask = false; assert.equal(response.status, 200); throw new Error('task committed but receipt lost'); }
      return response;
    };
    runtime = await createExistingWebRuntime(config, { store, fetch: fetcher, now: () => f.now, website: websiteOrigin });
    await runtime.connect({ confirmed: true });
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
  } finally { runtime?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close(); }
});
