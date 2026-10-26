import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import canonicalize from 'canonicalize';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createRetirementController } from "../src/privacy/retirement.mjs";
import { createReceiptStatusService } from "../src/verification/receipt-status.mjs";
import { createReceiptStatusClient, createReceiptStatusDeviceSigner } from "../src/clients/receipt-status.mjs";
import { choicePutIntent } from '../src/shared/choice-snapshot-schema-v2.mjs';
import { digest } from '../src/shared/digest.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import { createHelpSearchClient } from "../../galaxy-web/src/features/help-search/help-search-client.mjs";
import { createChoiceSyncClient } from "../../galaxy-web/src/features/choice-sync/choice-sync-client.mjs";

// Actual signed Binding/Control/Consent HTTP and PGlite. The local CryptoKey
// store is a Map, not a claim about physical IndexedDB or a real user account.
export async function receiptStatusFixture({ database = null, migrateDatabase = true, repositories } = {}) {
  const base = Math.floor(Date.now() / 1000); let current = base;
  const endpoint = 'https://official.example.org';
  const policy = { version: 1, id: 'receipt-status-only-test', endpoint, operator: 'Synthetic fixture', reason: 'Receipt recovery boundary',
    announcedAt: base + 86000, stopWritesAt: base + 86400, takeoutUntil: base + 86402, statusUntil: base + 300000,
    contactUrl: endpoint + '/contact', deletionPolicyUrl: endpoint + '/deletion' };
  const retirement = createRetirementController(policy, { endpoint, now: () => current });
  const f = await serviceFixture(browserScopes, database, { migrateDatabase, repositories, now: base, retirement });
  f.access.now = f.bindings.now = f.identityControl.now = () => current;
  // Services expose purpose-limited signers, not their private server key. The
  // controlled-clock receipt authority therefore uses a separate explicit pin.
  const server = generateKeyPairSync('ed25519'), trustedKeys = new Map(f.bindings.trustedKeys);
  trustedKeys.set('receipt-fixture', { publicKeyPem: server.publicKey.export({ type: 'spki', format: 'pem' }),
    notBefore: base - 1, notAfter: base + 400000, revoked: false });
  const receiptStatus = createReceiptStatusService({ db: f.db, endpoint, signingKey: server.privateKey,
    kid: 'receipt-fixture', trustedKeys, now: () => current, retirement, choiceSnapshots: f.choices });
  const api = createApi({ ...f, receiptStatus, retirement, rateLimit: 1000 });
  const data = new Map(), requests = []; let runtime, search, cloud, drop = false, generation = 0;
  try {
    const caseId = randomUUID(), payload = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
      actorId: f.actor.subjectId, localRef: randomUUID(), title: 'Retained receipt source', summary: 'Synthetic public source',
      synthetic: true, source: { kind: 'local', reference: randomUUID() } };
    const grant = await f.authorize(payload, 'case.teaser.publish', { objectId: caseId, visibility: 'Public', purpose: 'public-profile' });
    await f.cases.submitV2(f.actor, grant);
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`;
    const transport = async (url, options) => {
      const path = new URL(url).pathname; requests.push({ path, authorization: Object.hasOwn(options.headers ?? {}, 'Authorization') });
      const response = await fetch(origin + path, options);
      if (drop && path === '/v2/choice-snapshots/put') { drop = false; throw new Error('synthetic committed lost ACK'); }
      return response;
    };
    runtime = await createExistingWebRuntime({ endpoint, trustedKeys: f.bindings.trustedKeys }, { now: () => current, fetch: transport,
      store: { get: async key => data.get(key), put: async (key, value) => data.set(key, value),update:memoryAtomicUpdate(data) } });
    await runtime.connect({ confirmed: true });
    const identity = (await runtime.status()).identity;
    const material = data.get(`device:${identity.subjectId}:${identity.deviceId}`);
    const publicState = await runtime.publicControl(identity.subjectId);
    const context = { subjectId: identity.subjectId, endpoint, generation,
      control: { deviceId: identity.deviceId, keyId: digest(material.publicKeyPem), epoch: publicState.epoch } };
    const getContext = () => ({ ...context, generation });
    search = createHelpSearchClient(runtime, { authenticated: true, subjectId: identity.subjectId });
    cloud = createChoiceSyncClient(runtime, { subjectId: identity.subjectId });
    const page = await search.query({ type: 'history', query: { query: payload.title } });
    const candidate = search.candidateKey(page.items[0]), snapshotId = randomUUID();
    await search.saveChoice({ id: snapshotId, expectedVersion: 0, localTaskRef: 'Sensitive original local task',
      visibleRationale: 'Sensitive original local rationale', rationaleAuthor: 'user', candidateKeys: [candidate], selectedKeys: [candidate], resultRefs: [] });
    await cloud.savePreference({ endpoint, expectedRevision: 0, enabled: true, snapshotIds: [snapshotId] });
    drop = true; await assert.rejects(cloud.sync(snapshotId), /lost ACK/);
    const pending = (await cloud.localState()).pending[snapshotId];
    const operation = { kind: 'choice-snapshot', snapshotId, versionId: pending.versionId, requestHash: digest(canonicalize(choicePutIntent(pending))) };
    const { kind: _kind, ...locator } = operation;
    const original = await runtime.api.call('/v2/choice-snapshots/receipt', locator);
    const signer = createReceiptStatusDeviceSigner({ endpoint, trustedKeys, getContext,
      getPrivateKey: async () => material.privateKey, now: () => current });
    const client = createReceiptStatusClient({ endpoint, trustedKeys, getContext,
      signReceiptStatus: signer, fetch: transport, now: () => current });
    const request = async (path, input, token = null) => {
      const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${String(token)}` } : {}) }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    };
    return { f, api, runtime, cloud, data, material, identity, operation, locator, original, context, getContext, signer, client, requests, request, retirement, policy, receiptStatus, transport, trustedKeys,
      now: () => current, setTime: value => { current = value; }, advance: seconds => { current += seconds; }, rebind: () => { generation++; },
      async close() { cloud?.close(); search?.close(); runtime?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!database) await f.db.close(); } };
  } catch (error) {
    cloud?.close(); search?.close(); runtime?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!database) await f.db.close(); throw error;
  }
}

export async function verifyReceiptStatusExpiredContinuity(database = null, options = {}) {
  const t = await receiptStatusFixture({ database, ...options });
  try {
    const tables = ['bindings', 'access_credentials', 'session_challenges', 'choice_snapshot_versions', 'choice_snapshot_preferences'];
    const snapshots = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await t.f.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows])));
    const before = await snapshots();
    t.setTime(t.policy.takeoutUntil + 1);
    assert.equal(t.retirement.phase(), 'status-only');
    assert.equal((await t.runtime.status()).connection, null);
    assert.equal((await t.request('/v2/choice-snapshots/receipt', t.locator, t.f.credential)).status, 401);
    assert.equal((await t.request('/v1/session-challenges', { bindingId: t.f.actor.bindingId, credentialHash: 'a'.repeat(64) })).status, 410);
    const start = t.requests.length, recovered = await t.client.query(t.operation);
    assert.equal(recovered.state, 'acknowledged'); assert.equal(recovered.currentAccessGranted, false); assert.equal(recovered.contentReturned, false);
    assert.equal(recovered.receipt.acceptedAt, t.original.receipt.acceptedAt);
    assert.deepEqual(await snapshots(), before, 'no new session/binding/preference, expiry mutation or permanent receipt ledger');
    assert.deepEqual(t.requests.slice(start).map(r => r.path), ['/v2/receipt-status/challenges', '/v2/receipt-status/query']);
    assert.ok(t.requests.slice(start).every(r => !r.authorization), 'no ordinary Bearer is minted or used');
    assert.equal(JSON.stringify(recovered).includes('Sensitive original'), false);
    const unknown = await t.client.query({ ...t.operation, versionId: randomUUID() });
    assert.equal(unknown.state, 'absent'); assert.equal(unknown.absenceMeaning, 'no-retained-owner-operation');
    t.setTime(t.policy.statusUntil); await assert.rejects(t.client.query(t.operation), /service_retired/);
    return { expiredSessionAndBinding: true, originalAcknowledgmentOnly: true, contentReturned: false, ordinarySessionCreated: false,
      retainedRowsUnchanged: true, statusDeadlineEnforced: true, localStore: 'Map', identity: 'synthetic', database: database ? 'caller-supplied' : 'PGlite' };
  } finally { await t.close(); }
}
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
