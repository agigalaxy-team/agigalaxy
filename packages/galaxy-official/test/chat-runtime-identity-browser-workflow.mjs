import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { serviceFixture } from './service-fixture.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createApi } from '../src/http.mjs';

// Uses the caller's installed browser without installing or changing anything
// globally. The loopback page is a secure context with real WebCrypto and IDB.
export async function verifyChatRuntimeIdentity({ playwrightModule, executablePath } = {}) {
  assert.equal(typeof playwrightModule, 'string');
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = ['packages/galaxy-web/src/chat-client.mjs', 'packages/galaxy-web/src/runtime.mjs',
    'packages/galaxy-official/test/chat-runtime-identity-continuity.test.mjs', 'packages/galaxy-official/test/chat-runtime-identity-browser-workflow.mjs'];
  const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
  const sourceHashes = await hashes();
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-chat-owner-'));
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  // Account/quota enforcement is covered by the full Contact/OIDC UI fixture.
  // This narrower test isolates actual member, identity, signature and lease.
  f.chat.requireAccountWithin = async () => {};
  f.chat.consumeInviteWithin = async () => {};
  f.chat.markInviteRespondedWithin = async () => {};
  const bodies = new Map(), requests = [], errors = [];
  f.chat.transport = { available: true, project: async () => {}, send: async input => {
    bodies.set(input.messageId, input.text); return { archiveId: input.messageId };
  }, read: async ({ ids }) => ids.filter(id => bodies.has(id)).map(id => ({ archiveId: id, text: bodies.get(id) })) };
  let browser, frontend, api;
  try {
    const bundled = await build({ stdin: { contents: `import {createWebRuntime} from './packages/galaxy-web/src/runtime.mjs';
      import {openDeviceKeyStore} from './packages/galaxy-core/src/domain/device-key-store.mjs';
      window.createWebRuntime=createWebRuntime;window.openDeviceKeyStore=openDeviceKeyStore;`, resolveDir: root, loader: 'js' },
      bundle: true, write: false, platform: 'browser', format: 'iife' });
    frontend = createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
      res.end(req.url === '/bundle.js' ? bundled.outputFiles[0].text : '<!doctype html><title>Chat owner continuity</title><script src="/bundle.js"></script>');
    });
    await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + frontend.address().port;
    const apiBrowserOrigin = 'https://galaxy-ui.example.org';
    api = createApi({ ...f, browserOrigins: [apiBrowserOrigin], rateLimit: 10000 });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const apiOrigin = 'http://127.0.0.1:' + api.address().port;
    browser = await chromium.launchPersistentContext(directory, { headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(f.bindings.endpoint + '/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const response = await page.request.fetch(apiOrigin + url.pathname + url.search, {
        method: req.method(), headers: { ...req.headers(), origin: apiBrowserOrigin }, data: req.postDataBuffer() ?? undefined,
      });
      const input = req.postData() ? JSON.parse(req.postData()) : null;
      requests.push({ path: url.pathname, status: response.status(),
        ...(url.pathname.endsWith('/send') ? { clientMessageId: input.clientMessageId } : {}) });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': origin } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => !!window.createWebRuntime);
    await page.evaluate(async ({ config, clock }) => {
      window.check = (value, message) => { if (!value) throw new Error(message); };
      window.deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
      window.pendingResult = operation => operation.then(value => ({ value }), error => ({ error: error.message, code: error.code }));
      window.changed = result => !!result.error && (result.code === 'receipt_status_authority_changed' || result.error.includes('身份或连接已改变'));
      window.prefix = 'galaxy-web:' + config.endpoint + ':';
      window.rawStore = await window.openDeviceKeyStore({ name: 'chat-owner-main' });
      window.getHook = null; window.putHook = null; window.netHook = null; window.dropSend = false;
      const store = { ...window.rawStore,
        get: async key => { const result = await window.rawStore.get(key); if (window.getHook) await window.getHook(key); return result; },
        put: async (key, value) => { if (window.putHook) await window.putHook(key, value); return window.rawStore.put(key, value); },
      };
      const transport = async (url, options) => {
        window.check(new URL(url).origin === config.endpoint, 'fixture cannot change the signing authority');
        const response = await fetch(url, options), path = new URL(url).pathname;
        if (window.dropSend && path.endsWith('/send')) { window.dropSend = false;
          window.check(response.status === 200, 'lost ACK must follow actual HTTP200'); throw new Error('synthetic committed chat ACK lost'); }
        if (window.netHook) await window.netHook(path); return response;
      };
      const settings = { endpoint: config.endpoint, trustedKeys: new Map(config.signingKeys.map(({ kid, ...pin }) => [kid, pin])) };
      window.runtime = await window.createWebRuntime(settings, { store, fetch: transport, now: () => clock });
      window.visitorChat = window.runtime.chat;
      await window.runtime.createIdentity({ confirmed: true }); await window.runtime.connect({ confirmed: true });
      window.A = (await window.runtime.status()).identity.subjectId;
      const savedA = await window.runtime.prepareRecovery(); window.codes = { [window.A]: savedA.code };
      await window.runtime.saveRecovery({ operationId: savedA.operationId, confirmed: true });
      const otherStore = await window.openDeviceKeyStore({ name: 'chat-owner-other' });
      const other = await window.createWebRuntime(settings, { store: otherStore, fetch: transport, now: () => clock });
      await other.createIdentity({ confirmed: true }); await other.connect({ confirmed: true });
      window.B = (await other.status()).identity.subjectId;
      const savedB = await other.prepareRecovery(); window.codes[window.B] = savedB.code; await other.saveRecovery({ operationId: savedB.operationId, confirmed: true });
      window.aChat = window.runtime.chat;
      const room = await window.runtime.chat.create({ title: 'Synthetic A B ordinary Room' }, { confirmed: true });
      window.roomId = room.roomId;
      const decisionId = crypto.randomUUID();
      await window.runtime.api.call('/v2/chat/rooms/' + room.roomId + '/propose', {
        decisionId, expectedRevision: room.revision, action: 'invite', targetSubjectId: window.B });
      await other.api.call('/v2/chat/rooms/' + room.roomId + '/accept', { decisionId, accept: true });
      other.close(); otherStore.close();
      window.switchOwner = async subjectId => {
        const result = await window.runtime.recover(window.codes[subjectId], { confirmed: true });
        window.codes[subjectId] = result.replacementCode;
        await window.runtime.confirmRecoveredCode({ operationId: result.operationId, confirmed: true }); await window.runtime.connect({ confirmed: true });
        window.check((await window.runtime.status()).identity.subjectId === subjectId, 'actual recovery selected expected subject');
      };
      window.lostSend = async text => {
        window.dropSend = true; const result = await window.pendingResult(window.runtime.chat.send(window.roomId, text, { confirmed: true }));
        window.check(result.error?.includes('ACK lost'), 'expected original committed ACK loss');
        return window.runtime.chat.pending(window.roomId);
      };
      window.holdRead = key => {
        const entered = window.deferred(), released = window.deferred();
        window.getHook = async actual => { if (actual === key) { window.getHook = null; entered.resolve(); await released.promise; } };
        return { entered: entered.promise, release: released.resolve };
      };
      window.holdPut = (key, predicate = () => true) => {
        const entered = window.deferred(), released = window.deferred();
        window.putHook = async (actual, value) => { if (actual === key && predicate(value)) { window.putHook = null; entered.resolve(); await released.promise; } };
        return { entered: entered.promise, release: released.resolve };
      };
      window.holdReceipt = () => {
        const entered = window.deferred(), released = window.deferred();
        window.netHook = async path => { if (path.endsWith('/receipt')) { window.netHook = null; entered.resolve(); await released.promise; } };
        return { entered: entered.promise, release: released.resolve };
      };
      window.aKey = window.prefix + window.A + ':chat-operation:' + window.roomId;
      window.bKey = window.prefix + window.B + ':chat-operation:' + window.roomId;
      await window.runtime.putLocal('chat-draft:' + window.roomId, 'A private unsent draft', window.A);
      const stopped = await window.lostSend('A selected stopped message');
      await window.runtime.chat.stopRetry(window.roomId, { confirmed: true }); window.aLocator = (await window.runtime.chat.stopped(window.roomId))[0];
      window.check(window.aLocator.requestHash === stopped.requestHash && !('text' in window.aLocator.input), 'stopped receipt keeps original body-free hash');
      window.aOriginal = await window.lostSend('A original pending selected message');
      window.readA = window.holdRead(window.aKey);
      window.oldARead = window.pendingResult(window.aChat.pending(window.roomId)); await window.readA.entered;
      await window.switchOwner(window.B);
    }, { config: { endpoint: f.bindings.endpoint, signingKeys: [...f.bindings.trustedKeys].map(([kid, pin]) => ({ kid, ...pin })) }, clock: f.now });

    const currentB = await page.evaluate(async () => {
      const room = await window.runtime.api.call('/v2/chat/rooms/' + window.roomId + '/read', {});
      await window.runtime.api.call('/v2/chat/rooms/' + window.roomId + '/decisions', {});
      window.bChat = window.runtime.chat;
      const pending = await window.runtime.chat.pending(window.roomId);
      window.check(!pending, 'B must read its own empty journal');
      window.check(window.bChat !== window.aChat, 'Chat instance must belong to current subject');
      window.check((await window.runtime.chat.stopped(window.roomId)).length === 0, 'B must not inherit A ACK locator');
      window.check((await window.runtime.chat.stoppedRooms()).roomIds.length === 0, 'B must not inherit A stopped index');
      window.check(!await window.runtime.getLocal('chat-draft:' + window.roomId, window.B), 'B must not inherit A unsent draft');
      window.check(window.changed(await window.pendingResult(window.aChat.send(window.roomId, 'forbidden old A confirmation', { confirmed: true }))), 'old A confirmed send cannot cross B');
      let visitorDenied = false; try { await window.visitorChat.pending(window.roomId); } catch (error) { visitorDenied = error.message.includes('身份或连接已改变'); }
      window.check(visitorDenied, 'visitor client cannot take over identity');
      await window.runtime.putLocal('chat-draft:' + window.roomId, 'B private unsent draft', window.B);
      window.bOriginal = await window.lostSend('B original pending selected message');
      window.readB = window.holdRead(window.bKey); window.oldBRead = window.pendingResult(window.bChat.pending(window.roomId)); await window.readB.entered;
      await window.switchOwner(window.A); window.readA.release(); window.readB.release();
      window.check(window.changed(await window.oldARead), 'A B A cannot revive the original A read lease');
      window.check(window.changed(await window.oldBRead), 'late B read cannot expose B journal to A');
      window.check(window.runtime.chat === window.aChat, 'same owner can reuse instance for a new explicit operation');
      const original = await window.runtime.chat.pending(window.roomId);
      window.check(original.requestHash === window.aOriginal.requestHash && original.input.clientMessageId === window.aOriginal.input.clientMessageId, 'fresh A action reads original A ID/hash');
      window.check(await window.runtime.getLocal('chat-draft:' + window.roomId, window.A) === 'A private unsent draft', 'A unsent draft survives independently');
      return { roomReadable: !!room, sameOwnerRecovered: true, oldReadsRejected: 2, ownerIsolation: true };
    });
    assert.deepEqual(currentB, { roomReadable: true, sameOwnerRecovered: true, oldReadsRejected: 2, ownerIsolation: true });

    const lateReceipt = await page.evaluate(async () => {
      const hold = window.holdReceipt(); const running = window.pendingResult(window.aChat.retry(window.roomId, { confirmed: true })); await hold.entered;
      await window.switchOwner(window.B); hold.release(); window.check(window.changed(await running), 'late A accepted receipt must be withheld from B');
      window.check((await window.rawStore.get(window.aKey)).requestHash === window.aOriginal.requestHash, 'late ACK must retain original A journal');
      window.check((await window.runtime.chat.pending(window.roomId)).requestHash === window.bOriginal.requestHash, 'late A ACK cannot clear B journal');
      const receipt = await window.runtime.chat.retry(window.roomId, { confirmed: true }); window.check(receipt.state === 'accepted', 'fresh B explicitly queries original B receipt');
      window.check(!await window.runtime.chat.pending(window.roomId), 'fresh B query clears only B');
      return { lateAckWithheld: true, originalIdsRetained: true, explicitBReceipt: receipt.state };
    });
    assert.deepEqual(lateReceipt, { lateAckWithheld: true, originalIdsRetained: true, explicitBReceipt: 'accepted' });

    const persisted = await page.evaluate(async () => {
      const hold = window.holdPut(window.bKey, value => !!value); const running = window.pendingResult(window.bChat.send(window.roomId, 'B prepared but never sent', { confirmed: true })); await hold.entered;
      await window.switchOwner(window.A); hold.release(); window.check(window.changed(await running), 'old B persistence cannot dispatch under A');
      const pending = await window.rawStore.get(window.bKey); window.check(pending.owner.subjectId === window.B, 'late journal put remains in fixed B partition'); window.bPrepared = pending;
      window.check((await window.runtime.chat.pending(window.roomId)).requestHash === window.aOriginal.requestHash, 'late B put cannot replace A original');
      const clear = window.holdPut(window.aKey, value => value === null); const completion = window.pendingResult(window.aChat.retry(window.roomId, { confirmed: true })); await clear.entered;
      await window.switchOwner(window.B); clear.release(); window.check(window.changed(await completion), 'old A clear completion cannot present ACK in B');
      window.check((await window.runtime.chat.pending(window.roomId)).requestHash === window.bPrepared.requestHash, 'A clear cannot clear B journal');
      await window.runtime.chat.stopRetry(window.roomId, { confirmed: true }); const own = (await window.runtime.chat.stopped(window.roomId))[0];
      window.check(own.owner.subjectId === window.B && own.requestHash === window.bPrepared.requestHash && !('text' in own.input), 'B stopped locator belongs only to B');
      const absent = await window.runtime.chat.reconcileStopped(window.roomId, own.input.clientMessageId); window.check(absent.state === 'absent', 'prepared B never dispatched after switch');
      await window.switchOwner(window.A); const stopped = await window.runtime.chat.stopped(window.roomId);
      window.check(stopped.length === 1 && stopped[0].requestHash === window.aLocator.requestHash && !stopped[0].receipt, 'B stopped ACK does not contaminate A');
      return { lateWriteRejected: true, lateClearRejected: true, fixedOwnerKeys: true, undispatchedState: absent.state };
    });
    assert.deepEqual(persisted, { lateWriteRejected: true, lateClearRejected: true, fixedOwnerKeys: true, undispatchedState: 'absent' });

    const rebound = await page.evaluate(async () => {
      const hold = window.holdReceipt(); const running = window.pendingResult(window.runtime.chat.reconcileStopped(window.roomId, window.aLocator.input.clientMessageId)); await hold.entered;
      await window.runtime.connect({ confirmed: true }); hold.release(); window.check(window.changed(await running), 'same owner binding change withholds old stopped receipt');
      window.check(!(await window.runtime.chat.stopped(window.roomId))[0].receipt, 'old binding ACK was not written');
      const receipt = await window.runtime.chat.reconcileStopped(window.roomId, window.aLocator.input.clientMessageId); window.check(receipt.state === 'accepted', 'new explicit operation may query original A stopped receipt');
      const read = window.holdRead(window.aKey); const pending = window.pendingResult(window.runtime.chat.pending(window.roomId)); await read.entered;
      await window.runtime.connect({ confirmed: true }); read.release(); window.check(window.changed(await pending), 'same owner current read must not cross binding');
      return { oldStoppedAckRejected: true, oldReadRejected: true, freshOriginalReceipt: receipt.state };
    });
    assert.deepEqual(rebound, { oldStoppedAckRejected: true, oldReadRejected: true, freshOriginalReceipt: 'accepted' });
    const locators = await page.evaluate(() => ({ A: window.aOriginal.input.clientMessageId, stopped: window.aLocator.input.clientMessageId,
      B: window.bOriginal.input.clientMessageId, prepared: window.bPrepared.input.clientMessageId }));
    assert.deepEqual(requests.filter(row => row.path.endsWith('/send')).map(row => row.clientMessageId).sort((a,b)=>a<b?-1:a>b?1:0), [locators.A, locators.stopped, locators.B].sort((a,b)=>a<b?-1:a>b?1:0),
      'only three explicitly selected messages were sent; recovering/querying does not resend or dispatch the held prepared envelope');
    assert.equal(requests.filter(row => row.path.endsWith('/rooms/create')).length, 1);
    const counts = (await f.db.query('SELECT (SELECT count(*)::int FROM chat_rooms) rooms,(SELECT count(*)::int FROM task_requests) tasks,(SELECT count(*)::int FROM cases) cases,(SELECT count(*)::int FROM task_participations) participations')).rows[0];
    assert.deepEqual(counts, { rooms: 1, tasks: 0, cases: 0, participations: 0 }); assert.deepEqual(errors, []);
    await page.evaluate(() => { window.runtime.close(); window.rawStore.close(); });
    assert.deepEqual(await hashes(), sourceHashes, 'all captured sources stayed fixed through the browser verification');
    const boundaries = ['current B member read and decisions', 'Chat instance selected for current owner', 'A/B unsent drafts isolated',
      'A/B pending journal isolated', 'A/B body-free stopped locator and index isolated', 'visitor does not adopt a later identity',
      'old A confirmation rejected while B active', 'original A read lease rejected after A B A', 'late B read rejected under A',
      'late A accepted HTTP receipt cannot clear B', 'late B journal persistence cannot dispatch under A',
      'late A journal clear cannot clear B or show A ACK', 'same-owner rebind rejects old stopped ACK', 'same-owner rebind rejects old pending read'];
    return { checks: boundaries.length, passed: boundaries.length, boundaries, sourceHashes, sourceChangedDuringRun: [], actualWebRuntime: true, actualSignedHttp: true, localStore: 'Chromium persistent IndexedDB', database: 'PGlite',
      syntheticMembers: true, accountQuotaFixtureIsolated: true, syntheticBodyTransport: true, physicalHostHumanAcceptance: false,
      transportOrigin: 'contained loopback page proxied with the exact fixture HTTPS browser Origin; signing authority remains official fixture endpoint',
      assertions: { currentB, lateReceipt, persisted, rebound, counts }, requests, pageErrors: errors };
  } finally {
    await browser?.close();
    for (const server of [api, frontend]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await f.db.close();
    const target = resolve(directory), temporary = resolve(tmpdir());
    assert.ok(target.startsWith(temporary + sep) && target.startsWith(resolve(join(temporary, 'galaxy-chat-owner-'))));
    await rm(target, { recursive: true, force: true });
  }
}
