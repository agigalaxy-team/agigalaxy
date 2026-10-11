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

export async function verifyChoiceRetainedReceiptBrowser({ playwrightModule, opensslPath, executablePath } = {}) {
  assert.equal(typeof playwrightModule, 'string'); assert.equal(typeof opensslPath, 'string');
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-choice-retained-')), t = await receiptStatusFixture();
  let vite, browser, api;
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url)), port = t.api.address().port;
    const keyFile = join(directory, 'fixture-key.pem'), certFile = join(directory, 'fixture-cert.pem');
    await promisify(execFile)(opensslPath, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-days', '1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { windowsHide: true });
    const target = 'http://127.0.0.1:' + port;
    vite = await createServer({ root, configFile: false, logLevel: 'error', plugins: [{ name: 'choice-retained-fixture', configureServer(server) {
      server.middlewares.use('/__choice_retained', (_q, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Choice retained receipt integration</title>'); });
    } }], server: { host: '127.0.0.1', port: 0, https: { key: await readFile(keyFile), cert: await readFile(certFile) },
      proxy: { '/v1': target, '/v2': target }, fs: { allow: [root] } } });
    await vite.listen(); const origin = 'https://127.0.0.1:' + vite.httpServer.address().port;
    t.api.closeAllConnections(); await new Promise(resolve => t.api.close(resolve));
    api = createApi({ ...t.f, receiptStatus: t.receiptStatus, retirement: t.retirement, browserOrigins: [origin], rateLimit: 1000 });
    await new Promise(resolve => api.listen(port, '127.0.0.1', resolve));
    browser = await chromium.launchPersistentContext(directory, { headless: true, ignoreHTTPSErrors: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const config = { endpoint: t.f.access.endpoint, signingKeys: [...t.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) };
    const setup = async () => {
      await page.goto(origin + '/__choice_retained');
      await page.evaluate(async ({ config, time }) => {
        const { createWebRuntime } = await import('/packages/galaxy-web/src/runtime.mjs');
        const { openDeviceKeyStore } = await import('/packages/galaxy-core/src/domain/device-key-store.mjs');
        const { createChoiceSyncClient } = await import('/packages/galaxy-web/src/choice-sync-client.mjs');
        const { createHelpSearchClient } = await import('/packages/galaxy-web/src/help-search-client.mjs');
        window.clock = time; window.requests = []; window.drop = false; window.readHook = null; window.writeHook = null;
        window.rawStore = await openDeviceKeyStore({ name: 'choice-retained-real-idb' });
        const store = { ...window.rawStore,
          get: async key => { const result = await window.rawStore.get(key); if (window.readHook) await window.readHook(key); return result; },
          put: async (key, value) => { await window.rawStore.put(key, value); if (window.writeHook) await window.writeHook(key); } };
        const fetcher = async (url, options) => {
          if (new URL(url).origin !== config.endpoint) throw new Error('Fixture authority changed.');
          const path = new URL(url).pathname; window.requests.push({ path, authorization: Object.hasOwn(options.headers ?? {}, 'Authorization'),
            ...(path === '/v2/choice-snapshots/put' ? { versionId: JSON.parse(options.body).versionId } : {}) });
          const response = await fetch(path, options);
          if (window.drop && path === '/v2/choice-snapshots/put') { window.drop = false; throw new Error('synthetic committed lost ACK'); } return response;
        };
        window.runtime = await createWebRuntime({ endpoint: config.endpoint, trustedKeys: new Map(config.signingKeys.map(({ kid, ...pin }) => [kid, pin])) },
          { store, fetch: fetcher, now: () => window.clock });
        window.startChoices = async () => { const subjectId = (await window.runtime.status()).identity.subjectId;
          window.cloud = createChoiceSyncClient(window.runtime, { subjectId });
          window.search = createHelpSearchClient(window.runtime, { subjectId, authenticated: true }); };
        if ((await window.runtime.status()).identity) await window.startChoices();
        window.publishChoice = async () => {
          const results = await window.search.query({ type: 'history', query: { query: 'Retained receipt source' } });
          const candidate = window.search.candidateKey(results.items[0]), id = crypto.randomUUID();
          await window.search.saveChoice({ id, expectedVersion: 0, localTaskRef: 'Private retained task', visibleRationale: 'Private retained reason',
            rationaleAuthor: 'user', candidateKeys: [candidate], selectedKeys: [candidate], resultRefs: [] });
          const preference = await window.cloud.preferences();
          await window.cloud.savePreference({ endpoint: config.endpoint, expectedRevision: preference.revision, enabled: true, snapshotIds: [...preference.snapshotIds, id] });
          window.drop = true; let lost = false; try { await window.cloud.sync(id); } catch (error) { lost = error.message.includes('lost ACK'); }
          if (!lost) throw new Error('Original business must commit with a lost ACK.');
          return (await window.cloud.retainedReceiptOperations()).find(row => row.snapshotId === id);
        };
      }, { config, time: t.now() });
    };
    await setup();
    const operations = await page.evaluate(async () => {
      await window.runtime.createIdentity({ confirmed: true }); await window.runtime.connect({ confirmed: true }); await window.startChoices();
      const pending = await window.publishChoice(), stopped = await window.publishChoice(); await window.cloud.discardPending(stopped.snapshotId);
      return { pending, stopped };
    });
    const localWait = await page.evaluate(async () => {
      let changed = false; window.readHook = async key => { if (key.endsWith(':choice-cloud-v2') && !changed) {
        changed = true; window.readHook = null; await window.runtime.connect({ confirmed: true }); window.runtime.disconnect(); } };
      const start = window.requests.length; let rejected = false;
      try { await window.cloud.retainedReceiptOperations(); } catch (error) { rejected = error.code === 'receipt_status_authority_changed'; }
      window.readHook = null; return { rejected, receiptCalls: window.requests.slice(start).filter(r => r.path.startsWith('/v2/receipt-status/')).length };
    });
    assert.deepEqual(localWait, { rejected: true, receiptCalls: 0 });
    await page.evaluate(() => { window.cloud.close(); window.search.close(); window.runtime.close(); window.rawStore.close(); });
    t.setTime(t.policy.takeoutUntil + 1); const before = (await t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows;
    const preferences = (await t.f.db.query('SELECT * FROM choice_snapshot_preferences ORDER BY subject_id')).rows;
    await setup();
    const localDirectory = await page.evaluate(async () => { const start = window.requests.length, rows = await window.cloud.retainedReceiptOperations();
      return { rows, requests: window.requests.length - start, connection: (await window.runtime.status()).connection }; });
    assert.equal(localDirectory.requests, 0); assert.equal(localDirectory.connection, null); assert.equal(localDirectory.rows.length, 2);
    assert.equal(JSON.stringify(localDirectory.rows).includes('Private retained'), false);
    assert.equal(localDirectory.rows.find(row => row.versionId === operations.pending.versionId).location, 'pending');
    assert.equal(localDirectory.rows.find(row => row.versionId === operations.stopped.versionId).location, 'stopped');
    const saved = await page.evaluate(async selected => {
      window.writeHook = key => { if (key.endsWith(':choice-cloud-v2')) { window.writeHook = null; window.runtime.disconnect(); } };
      let rejected = false; try { await window.cloud.reconcileRetained(selected.snapshotId, { versionId: selected.versionId }); }
      catch (error) { rejected = error.code === 'receipt_status_authority_changed'; }
      window.writeHook = null; const row = (await window.cloud.retainedReceiptOperations()).find(item => item.versionId === selected.versionId);
      const receipt = await window.cloud.reconcileRetained(row.snapshotId, { versionId: row.versionId });
      return { rejected, location: row.location, state: receipt.state, sameHash: receipt.requestHash === selected.requestHash, contentReturned: receipt.contentReturned };
    }, operations.pending);
    assert.deepEqual(saved, { rejected: true, location: 'receipt', state: 'acknowledged', sameHash: true, contentReturned: false });
    const stopped = await page.evaluate(async selected => window.cloud.reconcileRetained(selected.snapshotId, { versionId: selected.versionId }), operations.stopped);
    assert.equal(stopped.state, 'acknowledged'); assert.equal(stopped.currentAccessGranted, false);
    await t.f.db.query('UPDATE choice_snapshot_versions SET request_hash=$2 WHERE version_id=$1', [operations.stopped.versionId, '0'.repeat(64)]);
    const conflict = await page.evaluate(async selected => window.cloud.reconcileRetained(selected.snapshotId, { versionId: selected.versionId }), operations.stopped);
    assert.equal(conflict.state, 'conflict');
    await t.f.db.query('DELETE FROM choice_snapshot_versions WHERE version_id=$1', [operations.pending.versionId]);
    const absent = await page.evaluate(async selected => window.cloud.reconcileRetained(selected.snapshotId, { versionId: selected.versionId }), operations.pending);
    assert.equal(absent.state, 'absent'); assert.equal(absent.absenceMeaning, 'no-retained-owner-operation');
    const final = await page.evaluate(async () => ({ requests: window.requests, directory: await window.cloud.retainedReceiptOperations(), connection: (await window.runtime.status()).connection }));
    assert.ok(final.requests.every(row => row.path.startsWith('/v2/receipt-status/') && !row.authorization));
    assert.equal(final.connection, null); assert.equal(final.directory.length, 2);
    assert.deepEqual((await t.f.db.query('SELECT * FROM bindings ORDER BY id')).rows, before);
    assert.deepEqual((await t.f.db.query('SELECT * FROM choice_snapshot_preferences ORDER BY subject_id')).rows, preferences);
    assert.equal(errors.length, 0);
    return { checks: 4, passed: 4, localStore: 'Chromium persistent IndexedDB', actualSignedHttp: true, database: 'PGlite',
      boundaries: ['actual IDB read reconnect', 'reload all-session-expired local pending/stopped directory', 'ACK local-save completion lifecycle fence', 'stopped/absent/conflict no business retry'],
      ordinarySessionCreated: false, preferenceChanged: false, originalBusinessResent: false, privateContentReturned: false, pageErrors: 0 };
  } finally {
    await browser?.close(); await vite?.close(); if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); } await t.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'galaxy-choice-retained-'))); await rm(directory, { recursive: true, force: true });
  }
}
