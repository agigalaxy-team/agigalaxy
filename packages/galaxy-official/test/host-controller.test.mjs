import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";

test('host Case preview excludes other operations, cancels late writes and resumes after failure', async () => {
  let release, canceled = 0, readSignal;
  const controller = createHostConnectionController({ endpoint: 'https://official.example.org', client: {},
    readRequest: async () => ({}), sessions: { status: async () => ({ state: 'session-local', scopes: ['case-teaser'] }), invalidate() {} },
    caseClient: { prepare: request => request, cancel() { canceled++; },
      execute: () => new Promise(resolve => { release = resolve; }),
      get: (_id, options) => { readSignal = options.signal; return new Promise(resolve => { release = resolve; }); } } });
  const preview = await controller.prepareCase({ id: 'fixture' });
  await assert.rejects(controller.prepare(), /active/);
  await assert.rejects(controller.getCase('fixture'), /unavailable/);
  const submitted = controller.executeCase(preview, 'confirm');
  controller.cancel(); release({ version: 1 });
  await assert.rejects(submitted, /canceled/); assert.equal(canceled, 1);
  const reading = controller.getCase('fixture'); controller.disconnect();
  assert.equal(readSignal.aborted, true); release({ events: [] }); await assert.rejects(reading, /canceled/);
  const second = await controller.prepareCase({ id: 'second' });
  const completed = controller.executeCase(second, 'confirm'); release({ version: 2 });
  assert.deepEqual(await completed, { version: 2 });
});

test('host history query is explicit, paginated and canceled on exit', {timeout:5000}, async () => {
  let release, signal, calls = 0;
  const controller = createHostConnectionController({ endpoint: 'https://official.example.org',
    client: {}, sessions: { status: async () => ({ state: 'session-local' }) }, readRequest: async () => ({}),
    historyClient: { query(input, options) {
      assert.deepEqual(input, { query: 'compiler', limit: 8 });
      calls++; signal = options.signal; return new Promise(resolve => { release = resolve; });
    } } });
  await controller.status(); assert.equal(calls, 0);
  const pending = controller.queryHistory({ query: 'compiler', limit: 8 });
  await assert.rejects(controller.prepare(), /active/);
  await assert.rejects(controller.queryHistory({}), /unavailable/);
  controller.cancel(); assert.equal(signal.aborted, true);
  release({ items: [] }); await assert.rejects(pending, /canceled/);
  const next = controller.queryHistory({ query: 'compiler', limit: 8 });
  await Promise.resolve(); // queryHistory awaits its optional local feedback identity before dispatch.
  const page = { items: [], nextCursor: null }; release(page);
  assert.deepEqual(await next, page); assert.equal(calls, 2);
});

test('host controller cancels pending preparation and discards late connection success', async () => {
  let resolveRequest, resolveExecute, adopted = 0, discarded = 0, invalidated = 0;
  const preview = {};
  const controller = createHostConnectionController({ endpoint: 'https://official.example.org',
    readRequest: () => new Promise(resolve => { resolveRequest = resolve; }),
    client: { prepare: () => preview, cancel() {}, execute: () => new Promise(resolve => { resolveExecute = resolve; }) },
    sessions: { adopt() { adopted++; }, invalidate() { invalidated++; }, status: async () => ({ state: 'session-local' }) } });
  const first = controller.prepare(); controller.cancel(); resolveRequest({});
  await assert.rejects(first, /canceled/);
  const second = controller.prepare(); resolveRequest({}); await second;
  const running = controller.execute(preview, 'confirm');
  controller.cancel(); resolveExecute({ takeCredential() { discarded++; } });
  await assert.rejects(running, /canceled/);
  assert.equal(adopted, 0); assert.equal(discarded, 1); assert.equal(invalidated, 1);
});

test('cancellation while final local status is pending invalidates the adopted session', async () => {
  let resolveStatus, adopted = 0, invalidated = 0;
  const controller = createHostConnectionController({ endpoint: 'https://official.example.org', readRequest: async () => ({}),
    client: { prepare: () => ({}), cancel() {}, execute: async () => ({ takeCredential() {} }) },
    sessions: { adopt() { adopted++; }, invalidate() { invalidated++; },
      status: () => new Promise(resolve => { resolveStatus = resolve; }) } });
  const preview = await controller.prepare();
  const running = controller.execute(preview, 'confirm');
  await Promise.resolve();
  assert.equal(adopted, 1);
  controller.cancel(); resolveStatus({ state: 'session-local' });
  await assert.rejects(running, /canceled/);
  assert.equal(invalidated, 1);
});


test('host remote check is explicit, excludes concurrent connection and cancels without reopening late results', async () => {
  let release, signal, calls = 0;
  const controller = createHostConnectionController({ endpoint: 'https://official.example.org',
    client: {}, sessions: { status: async () => ({ state: 'session-local' }) }, readRequest: async () => ({}),
    statusClient: { check(options) { calls++; signal = options.signal; return new Promise(resolve => { release = resolve; }); } } });
  await controller.status(); assert.equal(calls, 0);
  const pending = controller.checkRemote();
  await assert.rejects(controller.prepare(), /active/);
  await assert.rejects(controller.checkRemote(), /unavailable/);
  controller.cancel(); assert.equal(signal.aborted, true);
  release({ state: 'binding-verified' });
  await assert.rejects(pending, /canceled/); assert.equal(calls, 1);
});
