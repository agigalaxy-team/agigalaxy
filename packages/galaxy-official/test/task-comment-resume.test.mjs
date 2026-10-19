import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {sha256Hex} from '../src/shared/web-primitives.mjs';
import { createExistingWebRuntime, confirmFixtureAccountLink } from './existing-web-identity-fixture.mjs';
import {createTaskCommentClient} from '../../galaxy-web/src/task-comment-client.mjs';

async function fixture() {
  const endpoint = 'https://official.example.org', clock = {now: Math.floor(Date.now() / 1000)};
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], {emailVerified: true});
  const local = new Map(), counts = {consents: 0, comments: 0, preparations: 0};
  let f, server, runtime, drop = null, lastSubmitted = null;
  const close = async () => {runtime?.close(); if (server) {server.closeAllConnections(); await new Promise(done => server.close(done));} await f?.db.close(); await issuer.close();};
  try {
    const provider = await createOidcLoginProvider({id: 'fixture', name: 'Synthetic OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => clock.now});
    f = await serviceFixture(browserScopes, null, {now: clock.now, identityProviders: [provider], syntheticCommunityQuota: false});
    f.access.now = f.consents.now = () => clock.now;
    server = createApi({...f, rateLimit: 1000}); await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const store = {get: async key => structuredClone(local.get(key)), put: async (key, value) => local.set(key, structuredClone(value)),
      update: async (key, change) => {const value = change(structuredClone(local.get(key))); local.set(key, structuredClone(value)); return structuredClone(value);}};
    runtime = await createExistingWebRuntime({endpoint, trustedKeys: f.bindings.trustedKeys}, {store, now: () => clock.now,
      fetch: async (url, options) => {
        const parsed = new URL(url), path = parsed.pathname;
        if (path === '/v1/consents') {
          counts.consents++;
          lastSubmitted = structuredClone([...local.values()].find(value => value?.active?.prepared)?.active);
          if (lastSubmitted) assert.equal(lastSubmitted.prepared.signedIntent, JSON.parse(options.body).signedIntent);
        }
        if (path === '/v2/comments') counts.comments++;
        if (drop?.path === path && drop.before) {drop = null; throw new Error('synthetic original send not delivered');}
        const result = await fetch(origin + path + parsed.search, options);
        if (drop?.path === path) {drop = null; assert.equal(result.status, 200); await result.arrayBuffer(); throw new Error('synthetic original ACK lost');}
        return result;
      }});
    await runtime.connect({confirmed: true});
    const started = await runtime.api.call('/v1/identity/begin', {providerId: 'fixture'}), callback = await issuer.authorize(started.authorizationUrl);
    const login = await fetch(origin + callback.pathname + callback.search); assert.equal(login.status, 200); await login.arrayBuffer();
    await confirmFixtureAccountLink(runtime, started.loginId);
    const subjectId = runtime.api.snapshot().subjectId, taskId = randomUUID(), task = {operationId: randomUUID(), taskId, caseId: null,
      intent: 'proactive-review', workContext: {goal: 'Read the exact original comment', currentSituation: 'Synthetic local recovery', attemptRefs: []},
      title: '[synthetic] Original comment recovery', summary: 'Private local integration scenario', visibility: 'Private',
      collaboration: 'open-assistance', enrollmentExpiresAt: clock.now + 3600};
    await runtime.api.call('/v2/tasks', await runtime.api.authorizePayload(task, {action: 'assistance.publish', objectId: task.operationId, visibility: 'Private', confirmed: true}));
    const api = {...runtime.api, prepareAuthorization: (...args) => {counts.preparations++; return runtime.api.prepareAuthorization(...args);}};
    const client = () => createTaskCommentClient({api, getLocal: runtime.getLocal, putLocal: runtime.putLocal, updateLocal: runtime.updateLocal,
      receiptStatus: runtime.receiptStatus, subjectId, taskId, now: () => clock.now});
    const key = 'comment-operations:' + endpoint + ':' + subjectId + ':' + taskId;
    const payload = body => ({schemaVersion: 2, id: randomUUID(), commentId: randomUUID(), taskId, expectedRevision: 0,
      kind: 'create', body, visibility: 'inherit-task', replyTo: null});
    return {f, runtime, clock, counts, local, key, client, payload, close, submitted: () => lastSubmitted,
      journal: () => runtime.getLocal(key, subjectId),
      drop: (path, before = false) => {drop = {path, before};}};
  } catch (error) {await close(); throw error;}
}

test('comments automatically reuse exact HTTP ACK and valid originals, but a new binding or expiry needs the saved preview', {timeout: 60000}, async () => {
  const f = await fixture();
  try {
    let client = f.client();
    const first = await client.prepare('comment', f.payload('Synthetic accepted original consent'), {visibility: 'Private', expiresAt: f.clock.now + 3000});
    f.drop('/v1/consents'); await assert.rejects(client.execute(first, {confirmed: true}), /ACK lost/);
    const accepted = structuredClone((await f.journal()).active), beforeAccepted = {...f.counts};
    f.runtime.api.disconnect(); await f.runtime.connect({confirmed: true}); client = f.client();
    assert.notEqual(f.runtime.api.snapshot().bindingId, accepted.prepared.intent.bindingId);
    assert.equal((await client.resumePending(first.operationId)).state, 'acknowledged');
    assert.equal(f.counts.consents, beforeAccepted.consents); assert.equal(f.counts.preparations, beforeAccepted.preparations);
    assert.equal((await client.get(first.payload.commentId)).body, first.payload.body);

    const second = await client.prepare('comment', f.payload('Synthetic accepted original business'), {visibility: 'Private'});
    f.drop('/v2/comments'); await assert.rejects(client.execute(second, {confirmed: true}), /ACK lost/);
    const beforeAck = {...f.counts}; assert.equal((await client.resumePending(second.operationId)).exactOperationConfirmed, true);
    assert.deepEqual(f.counts, beforeAck, 'an exact business ACK is read without another send or authorization');

    const third = await client.prepare('comment', f.payload('Synthetic absent permission across binding'), {visibility: 'Private', expiresAt: f.clock.now + 2000});
    f.drop('/v1/consents', true); await assert.rejects(client.execute(third, {confirmed: true}), /not delivered/);
    const original = structuredClone((await f.journal()).active);
    f.runtime.api.disconnect(); await f.runtime.connect({confirmed: true}); client = f.client();
    const beforeReview = {...f.counts};
    assert.equal((await client.resumePending(third.operationId)).reason, 'original-binding-changed');
    const view = await client.reviewPending(third.operationId), preview = await client.reviewAuthorization(third.operationId);
    assert.equal(view.payloadJson, original.payloadJson); assert.equal(view.payloadHash, original.payloadHash);
    assert.deepEqual(view.viewers, original.viewers); assert.equal(view.expiresAt, original.expiresAt);
    assert.equal(preview.expiresAt, original.expiresAt); assert.equal(preview.state, 'reauthorization-required');
    assert.deepEqual(f.counts, beforeReview, 'viewing an original absent permission performs zero signing/writes');
    assert.equal((await client.resumePending(third.operationId)).reason, 'original-binding-changed');
    assert.equal((await client.reauthorize(preview, {confirmed: true})).state, 'acknowledged', 'an unchanged background read does not invalidate the preview');
    assert.equal(f.counts.consents, beforeReview.consents + 1); assert.equal(f.counts.comments, beforeReview.comments + 1);
    assert.equal(f.submitted().payloadJson, original.payloadJson); assert.equal(f.submitted().prepared.intent.expiresAt, original.expiresAt);
    assert.equal((await f.f.db.query('SELECT count(*)::int n FROM task_comment_events_v2 WHERE id=$1', [third.operationId])).rows[0].n, 1);

    const stale = await client.prepare('comment', f.payload('Synthetic old preview lease'), {visibility: 'Private'});
    f.drop('/v1/consents', true); await assert.rejects(client.execute(stale, {confirmed: true}));
    const staleReview = await client.reviewAuthorization(stale.operationId), beforeStale = {...f.counts};
    f.runtime.api.disconnect(); await f.runtime.connect({confirmed: true});
    await assert.rejects(client.reauthorize(staleReview, {confirmed: true}), error => error.code === 'receipt_status_authority_changed');
    assert.deepEqual(f.counts, beforeStale); await f.client().stopLocalRetry(stale.operationId, {confirmed: true});

    client = f.client();
    const revoked = await client.prepare('comment', f.payload('Synthetic revoked original permission'), {visibility: 'Private'});
    f.drop('/v2/comments', true); await assert.rejects(client.execute(revoked, {confirmed: true}));
    const savedRevoked = structuredClone((await f.journal()).active), beforeRevoked = {...f.counts};
    await f.runtime.api.call('/v1/consents/' + savedRevoked.prepared.intent.id + '/revoke', {});
    assert.equal((await client.resumePending(revoked.operationId)).reason, 'original-authorization-revoked');
    assert.deepEqual(f.counts, beforeRevoked); await client.stopLocalRetry(revoked.operationId, {confirmed: true});

    const unsigned = await client.prepare('comment', f.payload('Synthetic missing original signed permission'), {visibility: 'Private'});
    f.drop('/v1/consents', true); await assert.rejects(client.execute(unsigned, {confirmed: true}));
    const missing = await f.journal(); missing.active.prepared = null;
    await f.runtime.putLocal(f.key, missing); const beforeMissing = {...f.counts};
    assert.equal((await client.resumePending(unsigned.operationId)).reason, 'original-authorization-unavailable');
    assert.deepEqual(f.counts, beforeMissing); await client.stopLocalRetry(unsigned.operationId, {confirmed: true});

    const aged = await client.prepare('comment', f.payload('Synthetic same binding aged transport'), {visibility: 'Private', expiresAt: f.clock.now + 1000});
    f.drop('/v1/consents', true); await assert.rejects(client.execute(aged, {confirmed: true}));
    const savedAged = structuredClone((await f.journal()).active); f.clock.now += 301;
    assert.equal((await client.resumePending(aged.operationId)).state, 'acknowledged');
    const refreshed = f.submitted(); assert.equal(refreshed.prepared.intent.bindingId, savedAged.prepared.intent.bindingId);
    assert.equal(refreshed.prepared.intent.expiresAt, savedAged.prepared.intent.expiresAt); assert.equal(refreshed.payloadJson, savedAged.payloadJson);
    assert.equal(refreshed.payloadHash, savedAged.payloadHash); assert.deepEqual(refreshed.previousAuthorizations[0], savedAged.prepared);

    const expired = await client.prepare('comment', f.payload('Synthetic expired original content'), {visibility: 'Private', expiresAt: f.clock.now + 20});
    f.drop('/v1/consents', true); await assert.rejects(client.execute(expired, {confirmed: true}));
    const expiredOriginal = structuredClone((await f.journal()).active), beforeExpiry = {...f.counts}; f.clock.now += 21;
    assert.equal((await client.resumePending(expired.operationId)).reason, 'authorization-expired'); assert.deepEqual(f.counts, beforeExpiry);
    assert.equal((await f.journal()).active.prepared.signedIntent, expiredOriginal.prepared.signedIntent);
    const expiredReview = await client.reviewAuthorization(expired.operationId);
    assert.equal(expiredReview.originalExpiresAt, expiredOriginal.expiresAt); assert.ok(expiredReview.expiresAt > expiredOriginal.expiresAt);
    await client.stopLocalRetry(expired.operationId, {confirmed: true});
    assert.equal(JSON.stringify(await f.journal()).includes(expired.payload.body), false);
    assert.equal((await client.resumePending(expired.operationId)).reason, 'stopped-local'); assert.deepEqual(f.counts, beforeExpiry);
  } finally {await f.close();}
});

async function controlledFixture() {
  const endpoint = 'https://official.example.org', subjectId = 'GUID' + 'A'.repeat(28), taskId = randomUUID(), data = new Map();
  const current = {subjectId, endpoint, bindingId: randomUUID(), generation: 1, scopes: ['assistance', 'moderation']};
  const counts = {consents: 0, comments: 0, signs: 0}, clock = {now: 2000000000}; let rejected = true, remaining = 0, receiptHook;
  const api = {endpoint, snapshot: () => current, prepareAuthorization: async (payloadJson, options) => {
    counts.signs++; return {version: 1, endpoint, payloadJson, signedIntent: 'synthetic-signature', intent: {id: randomUUID(), subjectId,
      bindingId: current.bindingId, endpoint, objectId: options.objectId, action: options.action, visibility: options.visibility,
      purpose: options.visibility === 'Public' ? 'public-profile' : 'operational', recipient: endpoint, fields: Object.keys(JSON.parse(payloadJson)),
      viewers: options.viewers, payloadHash: await sha256Hex(payloadJson), issuedAt: clock.now, expiresAt: options.expiresAt}};
    }, reconcileAuthorization: async prepared => ({state: 'acknowledged', consentId: prepared.intent.id, payloadJson: prepared.payloadJson}),
    submitAuthorization: async prepared => {counts.consents++; return {consentId: prepared.intent.id, payloadJson: prepared.payloadJson};},
    call: async (path, input) => {
      if (path.endsWith('/receipt')) {if (receiptHook) await receiptHook(); return {state: remaining === 2 ? 'acknowledged' : 'absent', operationId: input.operationId};}
      if (path === '/v2/account/quotas') return {accountVerified: true, restriction: null,
        quotas: [{category: 'comment', remaining, resetAt: new Date((clock.now + 3600) * 1000).toISOString()}]};
      if (path === '/v2/comments') {counts.comments++; if (rejected) throw Object.assign(new Error('community_quota_exceeded'),
        {code: 'community_quota_exceeded', status: 429, outcome: 'rejected', retryAt: new Date((clock.now + 3600) * 1000).toISOString()}); remaining = 2; return {};}
      throw new Error('Unexpected test API');
    }};
  const getLocal = async key => structuredClone(data.get(key)), putLocal = async (key, value) => data.set(key, structuredClone(value)),
    updateLocal = async (key, change) => {const value = change(structuredClone(data.get(key))); data.set(key, structuredClone(value)); return structuredClone(value);};
  return {client: createTaskCommentClient({api, getLocal, putLocal, updateLocal, subjectId, taskId, now: () => clock.now}), counts, data, current, taskId,
    setQuota: value => {remaining = value; rejected = false;}, hook: fn => {receiptHook = fn;}};
}

test('definite quota rejection keeps the original and performs no blind automatic POST before an actual quota change', async () => {
  const f = await controlledFixture(), payload = {schemaVersion: 2, id: randomUUID(), commentId: randomUUID(), taskId: f.taskId,
    expectedRevision: 0, kind: 'create', body: 'Synthetic quota wait', visibility: 'inherit-task', replyTo: null};
  const preview = await f.client.prepare('comment', payload, {visibility: 'Public'});
  await assert.rejects(f.client.execute(preview, {confirmed: true}), error => error.reason === 'quota-wait' && error.originalOperationRetained === true);
  const original = structuredClone([...f.data.values()][0].active), baseline = {...f.counts};
  const waiting = await f.client.resumePending(payload.id); assert.equal(waiting.reason, 'quota-wait'); assert.ok(waiting.retryAt);
  assert.equal((await f.client.reviewAuthorization(payload.id)).reason, 'quota-wait'); assert.deepEqual(f.counts, baseline);
  f.setQuota(1); assert.equal((await f.client.resumePending(payload.id)).state, 'acknowledged');
  assert.equal(f.counts.consents, baseline.consents); assert.equal(f.counts.signs, baseline.signs); assert.equal(f.counts.comments, baseline.comments + 1);
  assert.equal((await f.client.reviewPending(payload.id).catch(() => null)), null); assert.equal(original.payloadJson, preview.payloadJson);
});

test('a late exact ACK leaves a new operation in the local slot intact', async () => {
  const f = await controlledFixture(), payload = {schemaVersion: 2, id: randomUUID(), commentId: randomUUID(), taskId: f.taskId,
    expectedRevision: 0, kind: 'create', body: 'Synthetic original slot', visibility: 'inherit-task', replyTo: null};
  const preview = await f.client.prepare('comment', payload, {visibility: 'Public'});
  await assert.rejects(f.client.execute(preview, {confirmed: true}));
  const [key] = f.data.keys(), old = structuredClone(f.data.get(key).active), replacement = {...old, operationId: randomUUID(), journalRevision: randomUUID()};
  f.setQuota(2); f.hook(async () => {f.data.set(key, {...f.data.get(key), active: structuredClone(replacement)});});
  const baseline = {...f.counts}; assert.equal((await f.client.reconcile(old.operationId)).state, 'acknowledged');
  assert.equal(f.data.get(key).active.operationId, replacement.operationId); assert.deepEqual(f.counts, baseline);
  assert.ok(f.data.get(key).stopped.some(item => item.operationId === old.operationId && item.state === 'acknowledged'));
});
