import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { receiptStatusFixture } from './receipt-status-workflow.mjs';
import { createApi } from '../src/http.mjs';

// Caller supplies an installed browser SDK; this fixture adds no dependency or
// global browser configuration. It uses Chromium's real persistent IndexedDB,
// not an injected context/key provider or a fake IndexedDB implementation.
export async function verifyWebReceiptStatusRuntime({ playwrightModule, executablePath, opensslPath } = {}) {
  assert.equal(typeof playwrightModule, 'string', 'Provide the installed Playwright module path.');
  assert.equal(typeof opensslPath, 'string', 'Provide the installed OpenSSL executable path.');
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-receipt-browser-')), t = await receiptStatusFixture();
  let server, browser, api;
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    // API is the official createApi fixture; this Vite proxy changes transport
    // only. Signed authority/issuer/pins remain the exact official test origin.
    const apiPort = t.api.address().port, origin = 'http://127.0.0.1:' + apiPort;
    const keyFile = join(directory, 'fixture-key.pem'), certFile = join(directory, 'fixture-cert.pem');
    await promisify(execFile)(opensslPath, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-days', '1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { windowsHide: true });
    server = await createServer({ root, configFile: false, logLevel: 'error',
      plugins: [{ name: 'receipt-runtime-fixture', configureServer(s) { s.middlewares.use('/__receipt_runtime', (_q, response) => {
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Receipt runtime integration</title>');
      }); } }], server: { host: '127.0.0.1', port: 0, strictPort: false, https: { key: await readFile(keyFile), cert: await readFile(certFile) },
        proxy: { '/v1': origin, '/v2': origin }, fs: { allow: [root] } } });
    await server.listen();
    const pageOrigin = 'https://127.0.0.1:' + server.httpServer.address().port;
    t.api.closeAllConnections(); await new Promise(resolve => t.api.close(resolve));
    api = createApi({ ...t.f, receiptStatus: t.receiptStatus, retirement: t.retirement, browserOrigins: [pageOrigin], rateLimit: 1000 });
    await new Promise(resolve => api.listen(apiPort, '127.0.0.1', resolve));
    browser = await chromium.launchPersistentContext(directory, { headless: true, ignoreHTTPSErrors: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const publicConfig = { endpoint: t.f.access.endpoint, signingKeys: [...t.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) };
    const setup = async () => {
      await page.goto(pageOrigin + '/__receipt_runtime');
      await page.evaluate(async ({ config, clock }) => {
        const { createWebRuntime } = await import('/packages/galaxy-web/src/runtime.mjs');
        const { openDeviceKeyStore } = await import('/packages/galaxy-core/src/domain/device-key-store.mjs');
        const { createHelpSearchClient } = await import('/packages/galaxy-web/src/help-search-client.mjs');
        const { createChoiceSyncClient } = await import('/packages/galaxy-web/src/choice-sync-client.mjs');
        const { choicePutIntent } = await import('/packages/galaxy-official/src/shared/choice-snapshot-schema-v2.mjs');
        const { stableJson, sha256Hex } = await import('/packages/galaxy-official/src/shared/web-primitives.mjs');
        window.clock = clock; window.requests = []; window.queryHook = null; window.readHook = null; window.drop = false;
        const pins = new Map(config.signingKeys.map(({ kid, ...pin }) => [kid, pin]));
        window.rawStore = await openDeviceKeyStore({ name: 'receipt-runtime-persistent' });
        const store = { ...window.rawStore, get: async key => { const value = await window.rawStore.get(key); if (window.readHook) await window.readHook(key); return value; } };
        const transport = async (url, options) => {
          if (new URL(url).origin !== config.endpoint) throw new Error('test authority changed');
          const path = new URL(url).pathname; window.requests.push({ path, authorization: Object.hasOwn(options.headers ?? {}, 'Authorization'),
            ...(path === '/v2/choice-snapshots/put' ? { operationVersionId: JSON.parse(options.body).versionId } : {}) });
          const response = await fetch(path, options);
          if (window.drop && path === '/v2/choice-snapshots/put') { window.drop = false; throw new Error('synthetic committed lost ACK'); }
          if (window.queryHook) await window.queryHook(path); return response;
        };
        window.runtime = await createWebRuntime({ endpoint: config.endpoint, trustedKeys: pins }, { store, fetch: transport, now: () => window.clock });
        window.createOtherRuntime = async name => {
          const otherStore = await openDeviceKeyStore({ name });
          const value = await createWebRuntime({ endpoint: config.endpoint, trustedKeys: pins }, { store: otherStore, fetch: transport, now: () => window.clock });
          await value.createIdentity({ confirmed: true }); await value.connect({ confirmed: true }); return { value, otherStore };
        };
        window.publishChoice = async () => {
          const subjectId = (await window.runtime.status()).identity.subjectId;
          const search = createHelpSearchClient(window.runtime, { authenticated: true, subjectId }), cloud = createChoiceSyncClient(window.runtime, { subjectId });
          const page = await search.query({ type: 'history', query: { query: 'Retained receipt source' } }), candidate = search.candidateKey(page.items[0]), snapshotId = crypto.randomUUID();
          await search.saveChoice({ id: snapshotId, expectedVersion: 0, localTaskRef: 'Private browser task', visibleRationale: 'Private browser rationale',
            rationaleAuthor: 'user', candidateKeys: [candidate], selectedKeys: [candidate], resultRefs: [] });
          await cloud.savePreference({ endpoint: config.endpoint, expectedRevision: 0, enabled: true, snapshotIds: [snapshotId] });
          window.drop = true; let failed = false; try { await cloud.sync(snapshotId); } catch (error) { failed = error.message.includes('lost ACK'); }
          if (!failed) throw new Error('Expected the original committed lost ACK.');
          const pending = (await cloud.localState()).pending[snapshotId];
          const operation = { kind: 'choice-snapshot', snapshotId, versionId: pending.versionId, requestHash: await sha256Hex(stableJson(choicePutIntent(pending))) };
          search.close(); cloud.close(); return operation;
        };
      }, { config: publicConfig, clock: t.now() });
    };
    await setup();
    await page.evaluate(async () => { await window.runtime.createIdentity({ confirmed: true }); await window.runtime.connect({ confirmed: true }); window.operation = await window.publishChoice(); });
    const original = await page.evaluate(async () => { const result = await window.runtime.receiptStatus.query(window.operation); return { state: result.state, receipt: result.receipt }; });
    assert.equal(original.state, 'acknowledged');
    const rebind = await page.evaluate(async () => {
      let hook = '/v2/receipt-status/challenges', changed = false;
      window.queryHook = async path => { if (path === hook && !changed) { changed = true; await window.runtime.connect({ confirmed: true }); } };
      let start = window.requests.length, first = false;
      try { await window.runtime.receiptStatus.query(window.operation); } catch (error) { first = error.code === 'receipt_status_authority_changed'; }
      const challengeQueryCalls = window.requests.slice(start).filter(r => r.path === '/v2/receipt-status/query').length;
      hook = '/v2/receipt-status/query'; changed = false; start = window.requests.length; let late = false;
      try { await window.runtime.receiptStatus.query(window.operation); } catch (error) { late = error.code === 'receipt_status_authority_changed'; }
      const lateCalls = window.requests.slice(start).filter(r => r.path === hook).length;
      window.queryHook = null; window.runtime.disconnect(); changed = false;
      window.queryHook = async path => { if (path === '/v2/receipt-status/challenges' && !changed) { changed = true; await window.runtime.connect({ confirmed: true }); window.runtime.disconnect(); } };
      start = window.requests.length; let aba = false;
      try { await window.runtime.receiptStatus.query(window.operation); } catch (error) { aba = error.code === 'receipt_status_authority_changed'; }
      const abaCalls = window.requests.slice(start).filter(r => r.path === '/v2/receipt-status/query').length;
      window.queryHook = null;
      return { first, challengeQueryCalls, late, lateCalls, aba, abaCalls };
    });
    assert.deepEqual(rebind, { first: true, challengeQueryCalls: 0, late: true, lateCalls: 1, aba: true, abaCalls: 0 });
    const localAwait = await page.evaluate(async () => {
      await window.runtime.connect({ confirmed: true }); let changed = false;
      window.readHook = async key => { if (key.startsWith('device:') && !changed) { changed = true; window.readHook = null; await window.runtime.connect({ confirmed: true }); } };
      const start = window.requests.length; let withheld = false;
      try { await window.runtime.receiptStatus.query(window.operation); } catch (error) { withheld = error.code === 'receipt_status_authority_changed'; }
      window.readHook = null;
      return { withheld, receiptCalls: window.requests.slice(start).filter(r => r.path.startsWith('/v2/receipt-status/')).length };
    });
    assert.deepEqual(localAwait, { withheld: true, receiptCalls: 0 });
    const switched = await page.evaluate(async () => {
      const second = await window.createOtherRuntime('receipt-other-owner');
      const recovery = await second.value.prepareRecovery(); await second.value.saveRecovery({ operationId: recovery.operationId, confirmed: true });
      const oldOwner = (await window.runtime.status()).identity.subjectId; let changed = false;
      window.queryHook = async path => { if (path === '/v2/receipt-status/query' && !changed) { changed = true;
        await window.runtime.recover(recovery.code, { confirmed: true }); await window.runtime.publicControl((await window.runtime.status()).identity.subjectId); } };
      let withheld = false; try { await window.runtime.receiptStatus.query(window.operation); } catch (error) { withheld = error.code === 'receipt_status_authority_changed'; }
      window.queryHook = null; const newOwner = (await window.runtime.status()).identity.subjectId;
      const prior = await window.runtime.receiptStatus.query(window.operation);
      second.value.close(); second.otherStore.close();
      return { withheld, ownerChanged: newOwner !== oldOwner, state: prior.state, contentReturned: prior.contentReturned };
    });
    assert.deepEqual(switched, { withheld: true, ownerChanged: true, state: 'absent', contentReturned: false });
    const device = await page.evaluate(async () => {
      const subjectId = (await window.runtime.status()).identity.subjectId, before = (await window.runtime.status()).identity.deviceId;
      const offer = await window.runtime.deviceHandoff.createOffer(subjectId, { confirmed: true });
      const approval = await window.runtime.deviceHandoff.approveOffer(offer, { confirmed: true }); let changed = false;
      window.queryHook = async path => { if (path === '/v2/receipt-status/query' && !changed) { changed = true;
        await window.runtime.deviceHandoff.acceptApproval(approval, { confirmed: true }); await window.runtime.publicControl(subjectId); } };
      let withheld = false; try { await window.runtime.receiptStatus.query(window.operation); } catch (error) { withheld = error.code === 'receipt_status_authority_changed'; }
      window.queryHook = null; const active = (await window.runtime.status()).identity;
      await window.runtime.connect({ confirmed: true }); window.finalOperation = await window.publishChoice();
      return { withheld, sameSubject: active.subjectId === subjectId, deviceChanged: active.deviceId !== before };
    });
    assert.deepEqual(device, { withheld: true, sameSubject: true, deviceChanged: true });
    const operation = await page.evaluate(() => window.finalOperation);
    const businessVersions = await page.evaluate(() => window.requests.filter(r => r.path === '/v2/choice-snapshots/put').map(r => r.operationVersionId));
    const order = (a, b) => a.localeCompare(b);
    assert.deepEqual(businessVersions.sort(order), [original.receipt.versionId, operation.versionId].sort(order), 'each explicitly authored Choice was dispatched once; none of the recovery paths resends it');
    const beforeBindings = (await t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows;
    await page.evaluate(() => { window.runtime.close(); window.rawStore.close(); });
    // Real browser reload retains the IDB CryptoKey and verified control cache,
    // but no ordinary API session is serialized or silently re-established.
    t.setTime(t.policy.takeoutUntil + 1); await setup();
    const expired = await page.evaluate(async input => {
      const start = window.requests.length, initial = (await window.runtime.status()).connection;
      const result = await window.runtime.receiptStatus.query(input);
      return { initial, final: (await window.runtime.status()).connection, state: result.state, contentReturned: result.contentReturned,
        currentAccessGranted: result.currentAccessGranted, paths: window.requests.slice(start).map(r => r.path),
        bearer: window.requests.slice(start).some(r => r.authorization), privateText: JSON.stringify(result).includes('Private browser') };
    }, operation);
    assert.deepEqual(expired, { initial: null, final: null, state: 'acknowledged', contentReturned: false, currentAccessGranted: false,
      paths: ['/v2/receipt-status/challenges', '/v2/receipt-status/query'], bearer: false, privateText: false });
    assert.deepEqual((await t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows, beforeBindings);
    assert.equal(errors.length, 0);
    return { checks: 6, passed: 6, localStore: 'Chromium persistent IndexedDB', actualSignedHttp: true, database: 'PGlite',
      syntheticIdentity: true, ordinarySessionCreatedDuringRecovery: false, originalBusinessResent: false,
      boundaries: ['same-owner rebind and null-snapshot ABA', 'real IDB await reconnect', 'real signed different-owner recovery',
        'real same-owner device handoff', 'runtime reload all-session-expired original ACK', 'no private content/new binding'], pageErrors: 0 };
  } finally {
    await browser?.close(); await server?.close(); if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } await t.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'galaxy-receipt-browser-'))); await rm(directory, { recursive: true, force: true });
  }
}
