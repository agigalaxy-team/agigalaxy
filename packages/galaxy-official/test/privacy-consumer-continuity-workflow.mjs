import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import { createRecoveryMaterial } from '../../galaxy-core/src/domain/identity-material.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createServices } from '../src/services.mjs';
import { browserScopes } from '../src/browser-client.mjs';

// Real signed HTTP/service transactions; this journal is an explicit Map
// double, not evidence for Chromium IndexedDB, production data or accounts.
function memoryStore() {
  const values = new Map(), hooks = { get: null, put: null };
  const store = {
    async update(key,fn){const next=fn(structuredClone(values.get(key)));if(next&&typeof next.then==='function'){if(next instanceof Promise)void next.catch(()=>{});throw Error('local_update_async_callback');}const committed=structuredClone(next);values.set(key,committed);await hooks.put?.(key,committed);return structuredClone(committed);},
    get: async key => { const value = structuredClone(values.get(key)); await hooks.get?.(key, value); return value; },
    put: async (key, value) => { values.set(key, structuredClone(value)); await hooks.put?.(key, value); },
    async prepareRecovery(subjectId, operationId) {
      const key = `pending-recovery:${subjectId}:${operationId}`, old = await store.get(key); if (old) return old;
      const value = { ...await createRecoveryMaterial(subjectId), operationId, saveDeclared: false, status: 'local-pending-registration' };
      await store.put(key, value); return value;
    },
    async declareSaved(subjectId, operationId) {
      const key = `pending-recovery:${subjectId}:${operationId}`, value = await store.get(key); assert.ok(value);
      await store.put(key, { ...value, saveDeclared: true });
    },
    async recordReceipt(subjectId, operationId, receipt) {
      assert.equal(receipt.subjectId, subjectId); assert.equal(receipt.operationId, operationId); assert.equal(receipt.state, 'committed');
      const key = `pending-recovery:${subjectId}:${operationId}`, value = await store.get(key); assert.ok(value);
      await store.put(key, { ...value, receipt, status: value.saveDeclared ? 'registered-save-declared' : 'registered-awaiting-save-declaration' });
    },
  };
  return { store, values, hooks };
}

export async function privacyConsumerFixture() {
  let at = Math.floor(Date.now() / 1000);
  const f = await serviceFixture(browserScopes, null, { now: at }), key = generateKeyPairSync('ed25519');
  const trustedKeys = new Map([['privacy-continuity', { publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }), notBefore: at - 1, notAfter: at + 200000, revoked: false }]]);
  const services = createServices({ db: f.db, endpoint: f.access.endpoint, kid: 'privacy-continuity', signingKey: key.privateKey,
    trustedKeys, allowedScopes: browserScopes, operator: 'Synthetic fixture', region: 'test', now: () => at });
  const api = createApi({ ...services, rateLimit: 10000 }), requests = [], wireHooks = { before: null, after: null }, clients = [];
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + api.address().port, config = { endpoint: f.access.endpoint, trustedKeys };
  const wire = async (url, options) => {
    assert.equal(new URL(url).origin, config.endpoint);
    const path = new URL(url).pathname;
    requests.push({ path, authenticated: Object.hasOwn(options.headers ?? {}, 'Authorization') });
    await wireHooks.before?.(path, options);
    const response = await fetch(local + path, options); await wireHooks.after?.(path, response); return response;
  };
  const makeRuntime = async journal => {
    const runtime = await createExistingWebRuntime(config, { store: journal.store, fetch: wire, now: () => at }); clients.push(runtime); return runtime;
  };
  const close = async () => { clients.forEach(client => client.close()); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close(); };
  try {
  const journal = memoryStore(), runtime = await makeRuntime(journal);
  await runtime.connect({ confirmed: true });
  const originalOwner = (await runtime.status()).identity, original = runtime.api.snapshot(), id = randomUUID(), marker = 'SYNTHETIC_PRIVATE_EXPORT_' + id;
  const root = { id, kind: 'case', localRef: randomUUID(), title: 'Synthetic privacy continuity', summary: marker,
    source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: original.subjectId, role: 'requester' }] };
  await runtime.api.call('/v1/cases', await runtime.api.authorizePayload(root, { action: 'case.teaser.publish', objectId: id, confirmed: true }));
  const prefix = `galaxy-web:${config.endpoint}:`, localKey = (name, subjectId = original.subjectId) => prefix + subjectId + ':' + name;
  return { f, services, runtime, journal, requests, wireHooks, originalOwner, original, marker, localKey, now: () => at, setTime: time => { at = time; },
    async makeOther() { const saved = memoryStore(), other = await makeRuntime(saved); await other.connect({ confirmed: true }); return { runtime: other, journal: saved }; },
    async createExport(datasets = ['case-events']) {
      const ticket = await runtime.privacy.createExport({ datasets }, { confirmed: true });
      if (datasets.includes('case-events')) assert.ok(JSON.stringify(await runtime.privacy.exportPage({ id: ticket.id, dataset: 'case-events' })).includes(marker));
      return ticket;
    },
    close,
  };
  } catch (error) { await close(); throw error; }
}

const intent = { action: 'request', scope: 'all-owned-service-data', reason: 'privacy', takeout: 'not-needed' };
const changed = error => error.code === 'privacy_authority_changed';
const submitCount = t => t.requests.filter(row => row.path === '/v1/deletion-requests/submit').length;

async function withDigestHook(action, hook) {
  const subtle = globalThis.crypto.subtle, original = subtle.digest.bind(subtle); let called = false;
  Object.defineProperty(subtle, 'digest', { configurable: true, value: async (algorithm, bytes) => {
    const result = await original(algorithm, bytes), text = new TextDecoder().decode(bytes);
    if (!called && hook.matches(text)) { called = true; await hook.run(); } return result;
  } });
  try { await action(); assert.equal(called, true); } finally { delete subtle.digest; }
}

export async function verifyPrivacyPageHashRebind() {
  const t = await privacyConsumerFixture();
  try {
    const ticket = await t.createExport(), before = t.runtime.api.snapshot();
    await withDigestHook(() => assert.rejects(t.runtime.privacy.exportPage({ id: ticket.id, dataset: 'case-events' }), changed), {
      matches: text => text.includes('"exportId":"' + ticket.id + '"'), run: () => t.runtime.connect({ confirmed: true }),
    });
    const after = t.runtime.api.snapshot(); assert.equal(after.subjectId, before.subjectId); assert.notEqual(after.generation, before.generation);
    assert.equal((await t.runtime.privacy.exportOperation()).selected.id, ticket.id);
    const start = t.requests.length; await assert.rejects(t.runtime.privacy.restoreExport(), changed); assert.equal(t.requests.length, start);
    await t.runtime.privacy.closeExport(); assert.equal(await t.runtime.privacy.exportOperation(), null);
    return { oldBodyWithheld: true, originalTicketPreserved: true, ownerCanExplicitlyRevoke: true };
  } finally { await t.close(); }
}

export async function verifyPrivacyFinalHashRebind() {
  const t = await privacyConsumerFixture();
  try {
    await t.createExport();
    await withDigestHook(() => assert.rejects(t.runtime.privacy.download(), changed), {
      matches: text => text.startsWith('{"dataset":"case-events"'), run: () => t.runtime.connect({ confirmed: true }),
    });
    return { oldContentWithheld: true, notReturnedAsPartial: true };
  } finally { await t.close(); }
}

export async function verifyPrivacyQueueAndLocalRead() {
  const t = await privacyConsumerFixture();
  try {
    let entered, release; const reached = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
    t.journal.hooks.get = async key => { if (key === t.localKey('deletion-operation')) { t.journal.hooks.get = null; entered(); await barrier; } };
    const first = t.runtime.privacy.prepareDeletion(intent), firstCheck = assert.rejects(first, changed); await reached;
    const queued = t.runtime.privacy.prepareDeletion(intent), queuedCheck = assert.rejects(queued, changed);
    await t.runtime.connect({ confirmed: true }); release(); await Promise.all([firstCheck, queuedCheck]);
    assert.equal(submitCount(t), 0); assert.equal(await t.runtime.privacy.pendingDeletion(), undefined);
    return { localReadWithheld: true, queuedOperationCannotAdoptNewLease: true, deletionSubmits: 0 };
  } finally { await t.close(); }
}

export async function verifyPrivacyPreviewAndSigner() {
  const t = await privacyConsumerFixture();
  try {
    const old = await t.runtime.privacy.prepareDeletion(intent); await t.runtime.connect({ confirmed: true });
    await assert.rejects(t.runtime.privacy.submitDeletion(old, { confirmed: true }), changed);
    const fresh = await t.runtime.privacy.prepareDeletion(intent); let rebound = false;
    t.journal.hooks.get = async key => { if (key === `device:${t.original.subjectId}:${t.originalOwner.deviceId}`) {
      t.journal.hooks.get = null; rebound = true; await t.runtime.connect({ confirmed: true });
    } };
    await assert.rejects(t.runtime.privacy.submitDeletion(fresh, { confirmed: true }), error => changed(error) || error.code === 'receipt_status_authority_changed');
    assert.equal(rebound, true); assert.equal(submitCount(t), 0); assert.equal(await t.runtime.privacy.pendingDeletion(), undefined);
    return { oldPreviewRejected: true, signerMaterialAwaitFenced: true, deletionSubmits: 0 };
  } finally { await t.close(); }
}

export async function verifyPrivacyPendingWriteAndUnknown() {
  const t = await privacyConsumerFixture();
  try {
    const preview = await t.runtime.privacy.prepareDeletion(intent); let rebound = false;
    t.journal.hooks.put = async key => { if (key === t.localKey('deletion-operation')) {
      t.journal.hooks.put = null; rebound = true; await t.runtime.connect({ confirmed: true });
    } };
    await assert.rejects(t.runtime.privacy.submitDeletion(preview, { confirmed: true }), changed);
    assert.equal(rebound, true); assert.equal(submitCount(t), 0);
    const pending = await t.runtime.privacy.pendingDeletion(); assert.equal(pending.intent.id, preview.intent.id); assert.ok(pending.signed);
    const checked = await t.runtime.privacy.reconcileDeletion(); assert.equal(checked.state, 'unacknowledged'); assert.equal(checked.operation.payloadHash, pending.payloadHash);
    assert.equal(submitCount(t), 0); await assert.rejects(t.runtime.privacy.reconcileDeletion({ retry: true }), changed); assert.equal(submitCount(t), 0);
    return { originalPendingRetained: true, absentIsNotCancellation: true, deletionSubmits: 0 };
  } finally { await t.close(); }
}

export async function verifyPrivacyLateOwnerSave() {
  const t = await privacyConsumerFixture();
  try {
    const other = await t.makeOther(), recovery = await other.runtime.prepareRecovery(); await other.runtime.saveRecovery({ operationId: recovery.operationId, confirmed: true });
    const nextOwner = (await other.runtime.status()).identity.subjectId, preview = await t.runtime.privacy.prepareDeletion(intent); let switched = false;
    t.journal.hooks.put = async key => { if (key === t.localKey('deletion-receipt:' + preview.intent.id)) {
      t.journal.hooks.put = null; await t.runtime.recover(recovery.code, { confirmed: true }); switched = true;
    } };
    await assert.rejects(t.runtime.privacy.submitDeletion(preview, { confirmed: true }), changed);
    assert.equal(switched, true); assert.equal((await t.runtime.status()).identity.subjectId, nextOwner); assert.equal(t.runtime.api.snapshot(), null);
    assert.equal(submitCount(t), 1);
    const saved = t.journal.values.get(t.localKey('deletion-receipt:' + preview.intent.id));
    assert.equal(saved.subjectId, t.original.subjectId); assert.equal(saved.receipt.id, preview.intent.id); assert.equal(saved.receipt.state, 'requested');
    assert.equal(t.journal.values.has(t.localKey('deletion-receipt:' + preview.intent.id, nextOwner)), false);
    assert.equal(t.journal.values.get(t.localKey('deletion-operation')).intent.id, preview.intent.id);
    assert.equal(await t.runtime.privacy.pendingDeletion(), undefined);
    return { actualSignedRecoveryChangedOwner: true, acceptedReceiptRetainedInOriginalNamespace: true, newOwnerJournalUntouched: true, deletionSubmits: 1 };
  } finally { await t.close(); }
}

export async function verifyPrivacyCommittedLostAckAndHolderABA() {
  const t = await privacyConsumerFixture();
  try {
    const preview = await t.runtime.privacy.prepareDeletion(intent); let rebound = false;
    t.wireHooks.after = async (path, response) => { if (path === '/v1/deletion-requests/submit') {
      t.wireHooks.after = null; assert.equal(response.status, 200); rebound = true; await t.runtime.connect({ confirmed: true });
    } };
    await assert.rejects(t.runtime.privacy.submitDeletion(preview, { confirmed: true }), /Authorization changed/); assert.equal(rebound, true);
    assert.equal((await t.runtime.privacy.pendingDeletion()).intent.id, preview.intent.id);
    const receipt = await t.runtime.privacy.reconcileDeletion(); assert.equal(receipt.id, preview.intent.id); assert.equal(submitCount(t), 1);
    await t.runtime.disconnect();
    const before = t.requests.length;
    assert.equal((await t.runtime.privacy.holderStatus(receipt.id)).state, 'requested');
    assert.ok(t.requests.slice(before).every(row => row.path === '/v1/deletion-requests/status' && !row.authenticated)); assert.equal(t.runtime.api.snapshot(), null);
    let aba = false; t.journal.hooks.get = async key => { if (key === t.localKey('deletion-receipt:' + receipt.id)) {
      t.journal.hooks.get = null; await t.runtime.connect({ confirmed: true }); await t.runtime.disconnect(); aba = true;
    } };
    const statusBefore = t.requests.filter(row => row.path === '/v1/deletion-requests/status').length;
    await assert.rejects(t.runtime.privacy.holderStatus(receipt.id), changed); assert.equal(aba, true);
    assert.equal(t.requests.filter(row => row.path === '/v1/deletion-requests/status').length, statusBefore); assert.equal(submitCount(t), 1);
    return { originalAckReadOnlyRecovery: true, deletionSubmits: 1, holderStatusWithoutOrdinarySession: true, nullConnectionABAFenced: true };
  } finally { await t.close(); }
}

export async function verifyPrivacyExpiryPartial() {
  const t = await privacyConsumerFixture();
  try {
    const ticket = await t.createExport(['case-events', 'identity']); let expired = false;
    // Shorten only the isolated ticket's retention deadline. Letting the
    // ordinary session expire too would correctly withhold every old page.
    const expiresAt = t.now() + 2;
    await t.f.db.query('UPDATE data_exports SET expires_at=$2 WHERE id=$1', [ticket.id, new Date(expiresAt * 1000).toISOString()]);
    const value = await t.runtime.privacy.download({ onProgress: () => { if (!expired) { expired = true; t.setTime(expiresAt + 1); } } });
    assert.equal(value.manifest.complete, false); assert.equal(value.manifest.pages.length, 1); assert.ok(value.content.includes(t.marker));
    assert.match(value.manifest.incompleteReason, /export_expired/); assert.ok(t.runtime.api.snapshot());
    await t.runtime.privacy.forgetExpiredExport(); assert.equal(await t.runtime.privacy.exportOperation(), null);
    return { previouslyAuthorizedPageRemainsPartial: true, expiredTicketCannotReadNextPage: true, currentOwnerUnchanged: true };
  } finally { await t.close(); }
}
