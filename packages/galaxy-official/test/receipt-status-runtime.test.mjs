import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { receiptStatusFixture } from './receipt-status-workflow.mjs';
import { createNativeRuntime } from '../../galaxy-edge-mcp/src/native-v2/runtime.mjs';
import { createHelpSearchClient } from "../../galaxy-web/src/features/help-search/help-search-client.mjs";
import { createChoiceSyncClient } from "../../galaxy-web/src/features/choice-sync/choice-sync-client.mjs";
import { choicePutIntent } from '../src/shared/choice-snapshot-schema-v2.mjs';
import { digest } from '../src/shared/digest.mjs';

async function nativeFixture() {
  const t = await receiptStatusFixture(), directory = await mkdtemp(join(tmpdir(), 'galaxy-receipt-native-'));
  let hook = null, drop = false, runtime;
  const fetcher = async (url, options) => {
    const response = await t.transport(url, options), path = new URL(url).pathname;
    if (drop && path === '/v2/choice-snapshots/put') { drop = false; throw new Error('synthetic committed lost ACK'); }
    if (hook) await hook(path); return response;
  };
  const config = { dataDirectory: directory, endpoint: t.f.access.endpoint, website: 'https://galaxy.example.org', trustedKeys: t.trustedKeys,
    fetch: fetcher, now: t.now };
  try {
    runtime = await createNativeRuntime(config); await runtime.initialize({ profile: 'minimal' }, { confirmed: true }); await runtime.connect({ confirmed: true });
    const subjectId = (await runtime.status()).identity;
    const facade = { api: runtime.api, status: async () => { const s = await runtime.status(); return { ...s, identity: { subjectId: s.identity } }; },
      getLocal: name => runtime.store.get('test-choice:' + subjectId + ':' + name), putLocal: (name, value) => runtime.store.put('test-choice:' + subjectId + ':' + name, value) };
    const search = createHelpSearchClient(facade, { authenticated: true, subjectId }), cloud = createChoiceSyncClient(facade, { subjectId });
    const page = await search.query({ type: 'history', query: { query: 'Retained receipt source' } }), candidate = search.candidateKey(page.items[0]), snapshotId = randomUUID();
    await search.saveChoice({ id: snapshotId, expectedVersion: 0, localTaskRef: 'Private native choice task', visibleRationale: 'Private native choice reason',
      rationaleAuthor: 'user', candidateKeys: [candidate], selectedKeys: [candidate], resultRefs: [] });
    await cloud.savePreference({ endpoint: config.endpoint, expectedRevision: 0, enabled: true, snapshotIds: [snapshotId] });
    drop = true; await assert.rejects(cloud.sync(snapshotId), /lost ACK/);
    const request = (await cloud.localState()).pending[snapshotId];
    const operation = { kind: 'choice-snapshot', snapshotId, versionId: request.versionId, requestHash: digest(canonicalize(choicePutIntent(request))) };
    search.close(); cloud.close();
    return { t, config, operation, subjectId, get runtime() { return runtime; }, setHook: value => { hook = value; },
      async restart() { runtime.close(); runtime = await createNativeRuntime(config); return runtime; },
      async close() { runtime?.close(); await t.close(); const resolved = join(tmpdir(), directory.slice(tmpdir().length + 1));
        assert.equal(resolved, directory); assert.ok(directory.startsWith(join(tmpdir(), 'galaxy-receipt-native-'))); await rm(directory, { recursive: true, force: true }); }
    };
  } catch (error) { await runtime?.close(); await t.close(); assert.ok(directory.startsWith(join(tmpdir(), 'galaxy-receipt-native-'))); await rm(directory, { recursive: true, force: true }); throw error; }
}

test('Native persistent device/cache survives restart; all sessions expire and only the original read-only receipt is recovered', async () => {
  const x = await nativeFixture();
  try {
    const before = (await x.t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows;
    await x.restart(); assert.equal(x.runtime.api.snapshot(), null);
    x.t.setTime(x.t.policy.takeoutUntil + 1); assert.equal(x.t.retirement.phase(), 'status-only');
    const start = x.t.requests.length, result = await x.runtime.receiptStatus.query(x.operation);
    assert.equal(result.state, 'acknowledged'); assert.equal(result.currentAccessGranted, false); assert.equal(result.contentReturned, false);
    assert.deepEqual(x.t.requests.slice(start).map(r => r.path), ['/v2/receipt-status/challenges', '/v2/receipt-status/query']);
    assert.ok(x.t.requests.slice(start).every(r => !r.authorization));
    assert.deepEqual((await x.t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows, before);
    assert.equal(x.runtime.api.snapshot(), null); assert.equal(JSON.stringify(result).includes('Private native'), false);
    x.runtime.close(); await assert.rejects(x.runtime.receiptStatus.query(x.operation), /authority_changed/);
  } finally { await x.close(); }
});

test('Native actual same-owner reconnect after challenge or late receipt withholds old completion without resending any business', async () => {
  const x = await nativeFixture();
  try {
    let path = '/v2/receipt-status/challenges', changed = false;
    x.setHook(async p => { if (p === path && !changed) { changed = true; await x.runtime.connect({ confirmed: true }); } });
    let start = x.t.requests.length;
    await assert.rejects(x.runtime.receiptStatus.query(x.operation), /authority_changed/);
    assert.equal(x.t.requests.slice(start).filter(r => r.path === '/v2/receipt-status/query').length, 0);
    path = '/v2/receipt-status/query'; changed = false; start = x.t.requests.length;
    await assert.rejects(x.runtime.receiptStatus.query(x.operation), /authority_changed/);
    assert.equal(x.t.requests.slice(start).filter(r => r.path === path).length, 1, 'the original read already completed; no remote cancellation is claimed');
    assert.equal(x.t.requests.slice(start).filter(r => r.path === '/v2/choice-snapshots/put').length, 0);
    x.setHook(null); assert.equal((await x.runtime.receiptStatus.query(x.operation)).state, 'acknowledged');
  } finally { await x.close(); }
});

test('Native no-session disconnect ABA during a challenge is fenced; an unselected local identity never authenticates a remote receipt', async () => {
  const x = await nativeFixture();
  try {
    await x.runtime.disconnect(); assert.equal(x.runtime.api.snapshot(), null);
    let changed = false;
    x.setHook(async p => { if (p === '/v2/receipt-status/challenges' && !changed) { changed = true; await x.runtime.connect({ confirmed: true }); await x.runtime.disconnect(); } });
    const start = x.t.requests.length;
    await assert.rejects(x.runtime.receiptStatus.query(x.operation), /authority_changed/);
    assert.equal(x.runtime.api.snapshot(), null); assert.equal(x.t.requests.slice(start).filter(r => r.path === '/v2/receipt-status/query').length, 0);
    x.setHook(null);
    const empty = await createNativeRuntime({ ...x.config, dataDirectory: join(x.config.dataDirectory, 'unselected') });
    try { const count = x.t.requests.length; await assert.rejects(empty.receiptStatus.query(x.operation), /authority_changed/); assert.equal(x.t.requests.length, count); }
    finally { await empty.close(); }
  } finally { await x.close(); }
});
