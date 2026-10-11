import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { createTaskCommentClient } from '../../galaxy-web/src/task-comment-client.mjs';

// Actual WebRuntime, Galaxy signed Consent, verified synthetic OIDC account and
// HTTP/PGlite. Map storage controls the completion boundary; this is not IDB or
// actual community authentication by a human. No models or host Agents run.
async function fixture() {
  const endpoint = 'https://official.example.org', now = Math.floor(Date.now() / 1000);
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  let f, server, runtime;
  const values = new Map(), counts = { consents: 0, comments: 0 };
  let dropCommentAck = false;
  const close = async () => {
    runtime?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await f?.db.close(); await issuer.close();
  };
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
    f = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
    server = createApi({ ...f, browserOrigins: ['https://galaxy.example.org'], rateLimit: 1000 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const local = 'http://127.0.0.1:' + server.address().port;
    runtime = await createWebRuntime({ endpoint, trustedKeys: f.bindings.trustedKeys }, {
      now: () => now,
      store: { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)),
        update: async (key, change) => {const value = change(structuredClone(values.get(key))); values.set(key, structuredClone(value)); return structuredClone(value);} },
      fetch: async (url, options) => {
        const parsed = new URL(url), path = parsed.pathname;
        if (path === '/v1/consents') counts.consents++;
        if (path === '/v2/comments') counts.comments++;
        const result = await fetch(local + path + parsed.search, { ...options, headers: { ...options.headers, Origin: 'https://galaxy.example.org' } });
        if (dropCommentAck && path === '/v2/comments' && result.status === 200) {
          dropCommentAck = false; await result.arrayBuffer(); throw new Error('synthetic lost comment ACK after HTTP acceptance');
        }
        return result;
      },
    });
    await runtime.createIdentity({ confirmed: true }); await runtime.connect({ confirmed: true });
    issuer.setAccount('synthetic-comment-lease-owner');
    const started = await runtime.api.call('/v1/identity/begin', { providerId: 'fixture' });
    const callback = await issuer.authorize(started.authorizationUrl);
    const response = await fetch(local + callback.pathname + callback.search);
    assert.equal(response.status, 200); await response.arrayBuffer();
    await runtime.confirmAccountLink(started.loginId, { confirmed: true });
    assert.equal((await runtime.api.call('/v2/account/quotas', {})).accountVerified, true);
    // Pre-existing signed Task fixture for comment leases. This test does not
    // exercise the website's separate Agent-continuity publication policy.
    const task = { taskId: randomUUID(), operationId: randomUUID(), caseId: null, intent: 'proactive-review',
      workContext: { goal: 'Review synthetic continuity', currentSituation: 'No failed attempt', attemptRefs: [] },
      title: 'Synthetic comment continuity', summary: 'Controlled local consumer boundary', visibility: 'Private',
      collaboration: 'open-assistance', enrollmentExpiresAt: now + 3600 };
    const taskConsent = await runtime.api.authorizePayload(task, { action: 'assistance.publish', objectId: task.operationId, visibility: 'Private', confirmed: true });
    await runtime.api.call('/v2/tasks', taskConsent);
    const payload = { schemaVersion: 2, id: randomUUID(), commentId: randomUUID(), taskId: task.taskId,
      expectedRevision: 0, kind: 'create', body: 'Synthetic private comment lease sentinel', visibility: 'inherit-task', replyTo: null };
    const base = { api: runtime.api, getLocal: runtime.getLocal, putLocal: runtime.putLocal,
      subjectId: runtime.api.snapshot().subjectId, taskId: task.taskId };
    return { f, runtime, values, counts, payload, base, close, loseNextCommentAck: () => { dropCommentAck = true; } };
  } catch (error) { await close(); throw error; }
}

test('original confirmed comment must not sign or publish after getLocal completion reconnects the same GUID', { timeout: 60000 }, async () => {
  const f = await fixture(); let switched = false, after;
  try {
    const before = f.runtime.api.snapshot(), baseline = { ...f.counts };
    const client = createTaskCommentClient({ ...f.base, getLocal: async key => {
      const value = await f.runtime.getLocal(key);
      if (!switched) { switched = true; f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true }); after = f.runtime.api.snapshot(); }
      return value;
    } });
    const preview = await client.prepare('comment', f.payload, { visibility: 'Private' });
    let result, error;
    try { result = await client.execute(preview, { confirmed: true }); } catch (caught) { error = caught; }
    const rows = (await f.f.db.query('SELECT count(*)::int n FROM task_comment_events_v2 WHERE id=$1', [f.payload.id])).rows[0].n;
    const observation = { actualWebRuntime: true, actualHttp: true, actualSignedConsent: true, account: 'synthetic verified OIDC/PKCE/JWS', database: 'PGlite',
      storage: 'Map controlled get completion, not physical IDB', realModelTurns: 0, switched,
      sameSubject: before.subjectId === after?.subjectId, bindingChanged: before.bindingId !== after?.bindingId,
      generationChanged: before.generation !== after?.generation,
      newConsentPosts: f.counts.consents - baseline.consents, commentPosts: f.counts.comments - baseline.comments,
      acceptedCommentEvents: rows, returnedState: result?.state ?? null, rejected: !!error };
    await writeFile(new URL('../../../../../../07-logs/development/collaboration-runtime-review/task-comment-consumer-lease-fixed.json', import.meta.url), JSON.stringify(observation, null, 2) + '\n');
    assert.equal(switched, true); assert.equal(before.subjectId, after.subjectId);
    assert.notEqual(before.bindingId, after.bindingId); assert.notEqual(before.generation, after.generation);
    assert.equal(observation.newConsentPosts, 0, 'a replacement binding cannot receive the original comment confirmation');
    assert.equal(observation.commentPosts, 0); assert.equal(rows, 0);
  } finally { await f.close(); }
});

test('pending private comment must be withheld when local read completion reconnects the same GUID', { timeout: 60000 }, async () => {
  const f = await fixture(); let switched = false, after;
  try {
    const original = createTaskCommentClient(f.base), preview = await original.prepare('comment', f.payload, { visibility: 'Private' });
    f.loseNextCommentAck(); await assert.rejects(original.execute(preview, { confirmed: true }));
    assert.equal((await f.f.db.query('SELECT count(*)::int n FROM task_comment_events_v2 WHERE id=$1', [f.payload.id])).rows[0].n, 1);
    const before = f.runtime.api.snapshot(), baseline = { ...f.counts };
    const client = createTaskCommentClient({ ...f.base, getLocal: async key => {
      const value = await f.runtime.getLocal(key);
      if (!switched) { switched = true; f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true }); after = f.runtime.api.snapshot(); }
      return value;
    } });
    let result, error;
    try { result = await client.pending(); } catch (caught) { error = caught; }
    const bodyReturned = !!result?.some(item => item.payload?.body === f.payload.body);
    const observation = { actualWebRuntime: true, actualHttp: true, actualSignedConsent: true, account: 'synthetic verified OIDC/PKCE/JWS', database: 'PGlite',
      storage: 'Map controlled get completion, not physical IDB', realModelTurns: 0, switched,
      sameSubject: before.subjectId === after?.subjectId, bindingChanged: before.bindingId !== after?.bindingId,
      generationChanged: before.generation !== after?.generation, originalAcceptedEvents: 1,
      newConsentPosts: f.counts.consents - baseline.consents, newCommentPosts: f.counts.comments - baseline.comments,
      originalPrivateBodyReturned: bodyReturned, withheld: !!error,
      originalLocatorRetained: [...f.values.values()].some(value => value?.active?.operationId === f.payload.id) };
    await writeFile(new URL('../../../../../../07-logs/development/collaboration-runtime-review/task-comment-pending-lease-fixed.json', import.meta.url), JSON.stringify(observation, null, 2) + '\n');
    assert.equal(switched, true); assert.equal(before.subjectId, after.subjectId); assert.notEqual(before.bindingId, after.bindingId);
    assert.equal(bodyReturned, false, 'a stale completion must not return the original private comment body');
    assert.equal(observation.newCommentPosts, 0); assert.equal(observation.originalLocatorRetained, true);
  } finally { await f.close(); }
});

test('a stale preview cannot reauthorize; lost ACK is recovered with exact original metadata and no new write', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    let client = createTaskCommentClient({ ...f.base, receiptStatus: f.runtime.receiptStatus });
    const old = await client.prepare('comment', f.payload, { visibility: 'Private' }), baseline = { ...f.counts };
    f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true });
    await assert.rejects(client.execute(old, { confirmed: true }), /身份|连接|receipt_status_authority_changed/);
    assert.equal(f.counts.consents, baseline.consents); assert.equal(f.counts.comments, baseline.comments);
    // A new explicit preview uses the same business ID/bytes, under a current lease.
    const current = await client.prepare('comment', f.payload, { visibility: 'Private' });
    f.loseNextCommentAck(); await assert.rejects(client.execute(current, { confirmed: true }), /lost comment ACK/);
    const original = [...f.values.values()].find(value => value?.active?.operationId === f.payload.id).active;
    const pendingHash = original.payloadHash, counts = { ...f.counts };
    f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true });
    client = createTaskCommentClient({ ...f.base, receiptStatus: f.runtime.receiptStatus });
    const receipt = await client.reconcile(f.payload.id);
    assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.commentId, f.payload.commentId);
    assert.deepEqual(f.counts, counts); assert.deepEqual(await client.pending(), []);
    const stored = [...f.values.values()].find(value => value?.stopped?.some(item => item.operationId === f.payload.id));
    assert.equal(stored.active, null);
    assert.ok(stored.stopped.some(item => item.operationId === f.payload.id && item.payloadHash === pendingHash && item.state === 'acknowledged'));
    assert.equal(JSON.stringify(stored).includes(f.payload.body), false);
    await assert.rejects(client.retry(f.payload.id, { confirmed: true }), /已停止/);
    assert.equal((await client.reconcile(f.payload.id)).state, 'acknowledged'); assert.deepEqual(f.counts, counts);
    assert.equal((await f.f.db.query('SELECT count(*)::int n FROM task_comment_events_v2 WHERE id=$1', [f.payload.id])).rows[0].n, 1);
  } finally { await f.close(); }
});

test('late ACK journal completion keeps the body-free original locator and withholds the old lease result', { timeout: 60000 }, async () => {
  const f = await fixture(); let switched = false;
  try {
    const before = f.runtime.api.snapshot();
    const client = createTaskCommentClient({ ...f.base, receiptStatus: f.runtime.receiptStatus, putLocal: async (key, value) => {
      await f.runtime.putLocal(key, value);
      if (!switched && value?.stopped?.some(item => item.operationId === f.payload.id && item.state === 'acknowledged')) {
        switched = true; f.runtime.api.disconnect(); await f.runtime.connect({ confirmed: true });
      }
    } });
    const preview = await client.prepare('comment', f.payload, { visibility: 'Private' });
    await assert.rejects(client.execute(preview, { confirmed: true }), /身份|连接|receipt_status_authority_changed/);
    assert.equal(switched, true); assert.notEqual(before.bindingId, f.runtime.api.snapshot().bindingId);
    const stored = [...f.values.values()].find(value => value?.stopped?.some(item => item.operationId === f.payload.id));
    assert.ok(stored); assert.equal(stored.active, null); assert.equal(JSON.stringify(stored).includes(f.payload.body), false);
    const counts = { ...f.counts }, fresh = createTaskCommentClient({ ...f.base, receiptStatus: f.runtime.receiptStatus });
    assert.equal((await fresh.reconcile(f.payload.id)).state, 'acknowledged'); assert.deepEqual(f.counts, counts);
    assert.deepEqual(await fresh.pending(), []);
  } finally { await f.close(); }
});

test('enqueue captures generation and runtime null-ABA lease before another operation releases the queue', async () => {
  // Explicit protocol/store doubles isolate the queue and null-ABA boundary.
  let generation = 1, lifecycle = 1, gateResolve, startedResolve;
  const gate = new Promise(resolve => { gateResolve = resolve; }), started = new Promise(resolve => { startedResolve = resolve; });
  const subjectId = 'synthetic-comment-owner', taskId = randomUUID(), endpoint = 'https://official.example.org';
  let reads = 0, writes = 0, business = 0, receiptCalls = 0;
  const snapshot = () => ({ subjectId, endpoint, bindingId: 'same-binding', generation });
  const api = { endpoint, snapshot, async call() { receiptCalls++; return { state: 'absent' }; },
    async prepareAuthorization() { business++; throw Error('must not sign queued stale input'); } };
  const receiptStatus = { captureLease() { const original = lifecycle; return { subjectId, endpoint, assertCurrent() {
    if (original !== lifecycle) throw Error('synthetic runtime lease changed');
  } }; } };
  const stopped = { operationId: randomUUID(), type: 'comment', payloadHash: 'a'.repeat(64), receiptPath: '/v2/comments/receipt', state: 'stopped-local' };
  const client = createTaskCommentClient({ api, receiptStatus, subjectId, taskId,
    getLocal: async () => { reads++; if (reads === 1) { startedResolve(); await gate; } return { active: null, stopped: [stopped] }; },
    putLocal: async () => { writes++; } });
  const preview = await client.prepare('comment', { schemaVersion: 2, id: randomUUID(), commentId: randomUUID(), taskId,
    expectedRevision: 0, kind: 'create', body: 'Synthetic queued material', visibility: 'inherit-task' });
  const first = client.reconcile(stopped.operationId); await started;
  const second = client.execute(preview, { confirmed: true });
  const settled = Promise.allSettled([first, second]); generation++; lifecycle++; gateResolve();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected')); assert.equal(reads, 1);
  assert.equal(writes, 0); assert.equal(business, 0); assert.equal(receiptCalls, 0);
  // Even equal snapshot metadata cannot resurrect a previously captured lease.
  const pending = client.pending(); lifecycle++; await assert.rejects(pending, /lease changed/);
});
