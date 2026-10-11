import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createNativeStore } from '../src/native-v2/store.mjs';
import { createCopilotSdkDriver } from '../src/native-v2/host-adapters/copilot-sdk.mjs';
import { createNativeWatch } from '../src/native-v2/watch.mjs';
import { createNativeWatchRuntime } from '../src/native-v2/watch-runtime.mjs';
import { createCopilotProtocolFixture } from './watch-host-copilot-process-fixture.mjs';

const tick = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function leaseControl() {
  let reference = {}, current = { subjectId: 'GUID' + 'A'.repeat(28), deviceId: randomUUID(), endpoint: 'https://synthetic.invalid', bindingId: randomUUID(), generation: 1 };
  return {
    snapshot: () => ({ ...current }),
    captureLease() { const ref = reference, value = { ...current }; return { ...value, assertCurrent() { if (reference !== ref) throw Error('lease_changed'); } }; },
    change(values = {}) { reference = {}; current = { ...current, ...values }; },
    nullAba() { reference = {}; current = { ...current, bindingId: null, generation: null }; } };
}
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-copilot-protocol-')), controls = leaseControl();
  const native = createNativeStore(directory), store = options.store ? options.store(native, controls) : native;
  const protocol = createCopilotProtocolFixture(options);
  const config = { createClient: protocol.createClient, cwd: directory, baseDirectory: join(directory, 'host-state'), store,
    captureLease: () => controls.captureLease(), completionTimeoutMs: options.child ? 2000 : 120, cancelTimeoutMs: 80, closeTimeoutMs: 500 };
  const drivers = [];
  const newDriver = () => { const driver = createCopilotSdkDriver(config); drivers.push(driver); return driver; };
  const driver = newDriver(), states = [];
  const input = { watchId: randomUUID(), work: { workId: randomUUID(), roomId: randomUUID(), items: [{ messageId: randomUUID(), sequence: '1', text: 'PRIVATE_INPUT_SENTINEL' }] },
    purpose: 'summarize authorized messages', model: 'chosen-model', cwd: directory, scopeKey: 'exact-original-scope',
    isCurrent: () => true, onState: async value => { states.push(value); } };
  return { directory, native, store, protocol, controls, input, states, driver, newDriver,
    async cleanup() {
      await Promise.all(drivers.map(d => d.close())); await protocol.cleanup();
      const root = resolve(directory), parent = resolve(tmpdir());
      assert.ok(root.startsWith(parent + sep) && root.split(sep).at(-1).startsWith('galaxy-copilot-protocol-'));
      await rm(root, { recursive: true, force: true });
    } };
}
async function records(f) {
  const dir = join(f.directory, 'native-v2', 'records'), files = await readdir(dir);
  return Promise.all(files.map(file => readFile(join(dir, file), 'utf8')));
}

test('inert by default, absolute trusted paths, and explicit metadata handshake create zero sessions/turns', async () => {
  const inert = createCopilotSdkDriver();
  assert.equal((await inert.capabilities()).available, false);
  assert.equal((await inert.run()).hostTurnDispatches, 0); assert.equal((await inert.close()).state, 'closed');
  assert.throws(() => createCopilotSdkDriver({ createClient() {}, cwd: 'relative', baseDirectory: 'relative' }), /trusted_configuration/);
  const f = await fixture();
  try {
    assert.equal(f.protocol.clients.length, 0);
    const capabilities = await f.driver.capabilities();
    assert.equal(capabilities.readerConfigurationConfirmed, false); assert.equal(capabilities.version, 'protocol-fixture-not-copilot');
    assert.equal(f.protocol.count('create'), 0); assert.equal(f.protocol.count('send'), 0);
    const config = f.protocol.clients[0].config;
    assert.deepEqual(config.connection, { kind: 'stdio' }); assert.equal(config.mode, 'empty');
    assert.equal(config.useLoggedInUser, false); assert.equal(config.logLevel, 'none');
    assert.deepEqual(config.builtinPluginDirectories, []); assert.ok(config.baseDirectory.startsWith(f.directory + sep));
    assert.equal(JSON.stringify(capabilities).includes('do-not-return'), false);
  } finally { await f.cleanup(); }
});

test('one work one session, completion joins original root user/range, journal contains no private payload', async () => {
  const f = await fixture();
  try {
    const result = await f.driver.run(f.input);
    assert.equal(result.state, 'completed'); assert.equal(result.output, 'authorized scoped analysis');
    assert.equal(result.hostTurnDispatches, 1); assert.equal(result.hostTurnAccepted, true);
    assert.equal(result.turnId, f.input.work.workId); assert.equal(f.protocol.count('create'), 1);
    const config = f.protocol.clients[0].sessionOptions[0];
    assert.deepEqual(config.availableTools, []); assert.deepEqual(config.tools, []); assert.deepEqual(config.mcpServers, {});
    assert.equal(config.enableConfigDiscovery, false); assert.equal(config.skipCustomInstructions, true);
    assert.deepEqual(config.allowedModels, ['chosen-model']); assert.equal(config.requestExtensions, false);
    assert.equal(config.onPermissionRequest().kind, 'denied-by-rules');
    const journal = (await records(f)).join('');
    for (const privateText of ['PRIVATE_INPUT_SENTINEL', 'authorized scoped analysis', 'private reasoning', 'do-not-return']) assert.equal(journal.includes(privateText), false);
    assert.equal(f.states[0].threadId, result.threadId); assert.equal(f.states[0].turnId, result.turnId);
    const prior = await f.driver.run(f.input); assert.equal(prior.state, 'completed'); assert.equal(prior.output, undefined);
    assert.equal(f.protocol.count('send'), 1); assert.equal(f.protocol.count('create'), 1);
    const next = await f.driver.run({ ...f.input, work: { ...f.input.work, workId: randomUUID() } });
    assert.equal(next.state, 'completed'); assert.notEqual(next.threadId, result.threadId); assert.equal(f.protocol.count('create'), 2);
  } finally { await f.cleanup(); }
});

test('null/uninitialized or nonempty reader tool metadata and unavailable chosen model prevent send', async () => {
  for (const tools of [null, [{ name: 'read_file' }]]) {
    const f = await fixture({ tools });
    try { const result = await f.driver.run(f.input); assert.equal(result.reason, 'host_reader_configuration_unconfirmed'); assert.equal(f.protocol.count('send'), 0); }
    finally { await f.cleanup(); }
  }
  const f = await fixture();
  try { const result = await f.driver.run({ ...f.input, model: 'not-selected-available-model' }); assert.equal(result.reason, 'selected-model-unavailable'); assert.equal(f.protocol.count('create'), 0); }
  finally { await f.cleanup(); }
});

test('lost send ACK and NativeFS fresh driver restore original session/hash without new send or private output', async () => {
  const f = await fixture({ sendAckLost: true });
  try {
    const unknown = await f.driver.run(f.input); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.hostTurnDispatches, 1);
    await f.driver.close();
    const fresh = f.newDriver(), recovered = await fresh.reconcile({ threadId: unknown.threadId, turnId: unknown.turnId });
    assert.equal(recovered.state, 'completed'); assert.equal(recovered.output, undefined);
    assert.equal(f.protocol.count('create'), 1); assert.equal(f.protocol.count('send'), 1); assert.equal(f.protocol.count('resume'), 1);
    const resume = f.protocol.clients[1].sessionOptions[0]; assert.equal(resume.continuePendingWork, false); assert.equal(resume.suppressResumeEvent, true);
    assert.equal((await fresh.reconcile({ threadId: 'different-original', turnId: unknown.turnId })).state, 'unknown');
    f.controls.change({ subjectId: 'GUID' + 'B'.repeat(28) });
    assert.equal((await f.newDriver().reconcile({ threadId: unknown.threadId, turnId: unknown.turnId })).state, 'unknown');
    assert.equal(f.protocol.count('resume'), 1);
  } finally { await f.cleanup(); }
});

test('session create ACK loss preserves original locator and never recreates or sends that operation', async () => {
  const f = await fixture();
  const factory = f.protocol.createClient;
  const driver = createCopilotSdkDriver({ createClient: config => {
    const pair = factory(config), create = pair.client.createSession;
    pair.client.createSession = async input => { await create(input); throw Error('synthetic_lost_create_ack'); }; return pair;
  }, cwd: f.directory, baseDirectory: join(f.directory, 'host-state'), store: f.native, captureLease: () => f.controls.captureLease(), completionTimeoutMs: 50 });
  try {
    const unknown = await driver.run(f.input); assert.equal(unknown.state, 'unknown'); assert.ok(unknown.threadId);
    await driver.close();
    const again = await f.newDriver().run(f.input); assert.equal(again.threadId, unknown.threadId); assert.equal(again.state, 'unknown');
    assert.equal(f.protocol.count('create'), 1); assert.equal(f.protocol.count('send'), 0);
  } finally { await driver.close(); await f.cleanup(); }
});

test('enqueue old lease, storage completion, same GUID reconnect, endpoint and null ABA all send zero old intent', async () => {
  const queued = await fixture();
  try {
    const operation = queued.driver.run(queued.input); queued.controls.change({ generation: 2 });
    assert.equal((await operation).suppressed, true); assert.equal(queued.protocol.clients.length, 0);
  } finally { await queued.cleanup(); }
  for (const mode of ['binding', 'device', 'endpoint', 'null-aba']) {
    let once = true;
    const f = await fixture({ store: (native, controls) => ({ get: native.get, update: async (...args) => {
      const value = await native.update(...args);
      if (once) { once = false; if (mode === 'null-aba') controls.nullAba(); else controls.change(mode === 'binding' ? { bindingId: randomUUID(), generation: 2 }
        : mode === 'device' ? { deviceId: randomUUID() } : { endpoint: 'https://other.synthetic.invalid' }); }
      return value;
    } }) });
    if (mode === 'null-aba') f.controls.nullAba();
    try { assert.equal((await f.driver.run(f.input)).suppressed, true); assert.equal(f.protocol.count('send'), 0); assert.equal(f.protocol.clients.length, 0); assert.equal((await records(f)).length, 1); }
    finally { await f.cleanup(); }
  }
});

test('tools/send/event and terminal journal awaits withhold late identity results but retain original locator', async () => {
  for (const stage of ['tools', 'send', 'events']) {
    const f = await fixture({ hook: async method => { if (method === stage) f.controls.change({ generation: 2 }); } });
    try {
      const result = await f.driver.run(f.input); assert.equal(result.suppressed, true); assert.equal(result.output, undefined); assert.ok(result.threadId);
      assert.equal(f.protocol.count('send'), stage === 'tools' ? 0 : 1);
      assert.equal(f.driver.status(f.input.watchId).state, 'idle');
    } finally { await f.cleanup(); }
  }
  const f = await fixture({ store: (native, controls) => ({ get: native.get, update: async (...args) => {
    const value = await native.update(...args); if (value.state === 'completed') controls.change({ subjectId: 'other-owner' }); return value;
  } }) });
  try { const result = await f.driver.run(f.input); assert.equal(result.suppressed, true); assert.equal(result.output, undefined);
    assert.equal(JSON.parse((await records(f))[0]).state, 'completed'); }
  finally { await f.cleanup(); }
});

test('unrelated message/range/subagent/tool and ephemeral idle do not assert completed', async () => {
  for (const corruption of ['wrong-message', 'wrong-range', 'subagent', 'tool', 'idle-only']) {
    const f = await fixture({ hook: async (method, input) => {
      if (method !== 'events') return;
      const session = f.protocol.sessions.get(input.sessionId), events = session.events;
      if (corruption === 'wrong-message') events[1].data.originatingMessageId = 'different-message';
      if (corruption === 'wrong-range') events[3].data.eventRange.startEventId = 'different-user';
      if (corruption === 'subagent') events[1].agentId = 'child-agent';
      if (corruption === 'tool') { if (!events.some(e => e.type === 'tool.execution_start')) events.push({ id: randomUUID(), type: 'tool.execution_start' }); }
      if (corruption === 'idle-only') session.events = [events[0], { id: randomUUID(), type: 'session.idle', ephemeral: true, data: {} }];
    } });
    try { const result = await f.driver.run(f.input); assert.equal(result.state, 'unknown'); assert.equal(result.output, undefined); assert.equal(f.protocol.count('send'), 1); }
    finally { await f.cleanup(); }
  }
});

test('cancel ACK remains unknown until original abort plus scoped session idle, and paused scope cannot restart intent', async () => {
  for (const abortTerminal of [false, true]) {
    const f = await fixture({ complete: false, abortTerminal });
    try {
      const started = deferred(), input = { ...f.input, onState: async value => { f.states.push(value); if (value.state === 'dispatching') started.resolve(); } };
      const running = f.driver.run(input); await started.promise; while (f.protocol.count('send') === 0) await tick();
      const stopped = await f.driver.cancel(input.watchId, { scopeKey: input.scopeKey });
      assert.equal(stopped.cancellationRequested, true); assert.equal(stopped.cancellationConfirmed, abortTerminal); assert.equal(stopped.executionEnded, abortTerminal);
      const result = await running; assert.equal(result.state, abortTerminal ? 'interrupted' : 'unknown');
      const old = await f.driver.run({ ...input, isCurrent: () => false }); assert.equal(old.hostTurnDispatches, 0); assert.equal(f.protocol.count('send'), 1);
    } finally { await f.cleanup(); }
  }
});

test('close is idempotent/drains and refuses to infer owned process exit from public SDK stop ACK', async () => {
  const f = await fixture({ publicExit: false });
  try {
    await f.driver.capabilities(); const first = f.driver.close(), second = f.driver.close(); assert.equal(first, second);
    const result = await first; assert.equal(result.state, 'shutdown-unconfirmed'); assert.equal(result.ownedProcessExitConfirmed, false); assert.equal(result.stopConfirmed, true);
    assert.equal(f.protocol.clients[0].stopCalls, 1); assert.equal((await f.driver.run(f.input)).hostTurnDispatches, 0);
  } finally { await f.cleanup(); }
  const held = deferred(), entered = deferred();
  const late = await fixture({ hook: async method => { if (method === 'start') { entered.resolve(); await held.promise; } } });
  try {
    const run = late.driver.run(late.input); await entered.promise; const closing = late.driver.close(); held.resolve();
    assert.equal((await run).suppressed, true); assert.equal(late.protocol.count('send'), 0); assert.equal((await closing).drained, true);
  } finally { held.resolve(); await late.cleanup(); }
});

test('actual owned Node protocol child completes once and close observes process exit, without SDK/model execution', async () => {
  const f = await fixture({ child: true });
  try {
    const result = await f.driver.run(f.input); assert.equal(result.state, 'completed'); assert.equal(f.protocol.processes.length, 1);
    const closed = await f.driver.close(); assert.equal(closed.state, 'closed'); assert.equal(closed.ownedProcessExitConfirmed, true);
    assert.equal(f.protocol.processes[0].exitCode, 0); assert.equal(f.protocol.count('send'), 1);
  } finally { await f.cleanup(); }
});

test('Watch opt-in completed work ACKs once; no change at 15min uses zero new sessions, 30min error backoff and 24h deadline', async () => {
  const f = await fixture(); let now = 1000, changed = true, fail = false, cursor = 0;
  const grantId = randomUUID(), roomId = randomUUID(), messageId = randomUUID(), timers = [];
  const api = { endpoint: f.controls.snapshot().endpoint, snapshot: () => f.controls.snapshot(), async call(path, input) {
    if (path.endsWith('agent-grants')) return { items: [{ grantId, bindingId: f.controls.snapshot().bindingId, state: 'active', expiresAt: now + 100000 }] };
    if (path.endsWith('history')) { if (fail) throw Error('synthetic_offline'); return { messages: changed && input.after === '0' ? [{ messageId, sequence: '1', subjectId: 'other', state: 'accepted', text: 'authorized event' }] : [], scannedThrough: '1', complete: true }; }
    if (path.endsWith('cursor')) { cursor++; return { kind: 'agent', agentGrantId: grantId, sequence: input.sequence }; }
    if (path.endsWith('agent-revoke')) return { revoked: true };
    throw Error('unexpected_watch_call'); } };
  const watch = createNativeWatch({ store: f.native, api, subjectId: f.controls.snapshot().subjectId, now: () => now });
  const runtime = createNativeWatchRuntime({ watch, hostDriver: f.driver, getHostLease: api.snapshot, now: () => now,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancelSchedule: timer => { timer.cancelled = true; } });
  try {
    const created = await watch.start({ roomId, agentGrantId: grantId, purpose: 'review', expiresAt: now + 86400 }, { confirmed: true });
    const id = created.items[0].id;
    await runtime.activate(id, { checkNow: false, host: { model: 'chosen-model', cwd: f.directory }, confirmed: true });
    assert.equal(f.protocol.count('send'), 0);
    assert.equal((await runtime.check(id)).state, 'processed'); assert.equal(cursor, 1); assert.equal(f.protocol.count('send'), 1);
    changed = false; now += 900; assert.equal((await runtime.check(id)).state, 'unchanged'); assert.equal(f.protocol.count('create'), 1);
    fail = true; for (let i = 0; i < 6; i++) await assert.rejects(runtime.check(id, 'event'), /synthetic_offline/);
    assert.equal(timers.at(-1).delay, 1800000);
    now = 1000 + 86401; assert.equal((await runtime.check(id)).state, 'inactive'); assert.equal(f.protocol.count('send'), 1);
  } finally { await runtime.dispose(); await f.cleanup(); }
});

test('concurrent fresh drivers reserve one original operation atomically in NativeFS', async () => {
  const f = await fixture();
  try {
    const other = f.newDriver(), results = await Promise.all([f.driver.run(f.input), other.run(f.input)]);
    assert.equal(f.protocol.count('create'), 1); assert.equal(f.protocol.count('send'), 1);
    assert.equal(results[0].threadId, results[1].threadId); assert.equal((await records(f)).length, 1);
    assert.ok(results.some(result => result.state === 'completed'));
  } finally { await f.cleanup(); }
});

test('reader gate is rechecked after journal/review awaits and onState late lease dispatches zero turns', async () => {
  const tools = [], f = await fixture({ tools });
  try {
    const result = await f.driver.run({ ...f.input, onState: async value => {
      if (value.state === 'dispatching') tools.push({ name: 'untrusted-new-tool' });
    } });
    assert.equal(result.reason, 'host_reader_configuration_unconfirmed'); assert.equal(f.protocol.count('send'), 0);
  } finally { await f.cleanup(); }
  const late = await fixture();
  try {
    const result = await late.driver.run({ ...late.input, onState: async value => {
      if (value.state === 'dispatching') late.controls.change({ generation: 2 });
    } });
    assert.equal(result.suppressed, true); assert.equal(late.protocol.count('send'), 0);
  } finally { await late.cleanup(); }
});

test('signal cancellation requests only the owned original abort and unknown running state is not false completion', async () => {
  const f = await fixture({ complete: false, abortTerminal: false });
  const controller = new AbortController();
  try {
    const running = f.driver.run({ ...f.input, signal: controller.signal });
    while (f.protocol.count('send') === 0) await tick(); controller.abort();
    const unknown = await running; assert.equal(unknown.state, 'unknown'); assert.equal(unknown.output, undefined);
    while (f.protocol.count('abort') === 0) await tick();
    const status = f.driver.status(f.input.watchId); assert.equal(status.modelRunning, null); assert.equal(status.executionEnded, false);
    await f.driver.close(); assert.equal(f.protocol.count('send'), 1);
  } finally { await f.cleanup(); }
});

test('original durable failure needs exact scoped session idle; provider diagnostics never enter receipt or journal', async () => {
  for (const idle of [false, true]) {
    const f = await fixture({ complete: false, hook: async (method, input) => {
      if (method !== 'events') return;
      const session = f.protocol.sessions.get(input.sessionId);
      if (session.events.length > 1) return;
      const error = { id: randomUUID(), parentId: session.events[0].id, timestamp: new Date().toISOString(), type: 'session.error',
        data: { errorType: 'authorization', message: 'PRIVATE_PROVIDER_DIAGNOSTIC', stack: 'private stack' } };
      session.events.push(error);
      if (idle) session.events.push({ id: randomUUID(), parentId: error.id, timestamp: new Date().toISOString(), type: 'session.idle', ephemeral: true, data: {} });
    } });
    try {
      const result = await f.driver.run(f.input); assert.equal(result.state, idle ? 'failed' : 'unknown'); assert.equal(result.output, undefined);
      assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_DIAGNOSTIC'), false);
      assert.equal((await records(f)).join('').includes('PRIVATE_PROVIDER_DIAGNOSTIC'), false);
      assert.equal(f.protocol.count('send'), 1);
    } finally { await f.cleanup(); }
  }
});

test('a newly captured equal public null lease cannot reuse a process owned by the old reference', async () => {
  const f = await fixture(); f.controls.nullAba();
  try {
    await f.driver.capabilities(); const starts = f.protocol.count('start');
    f.controls.nullAba();
    const result = await f.driver.run(f.input); assert.equal(result.state, 'unknown');
    assert.equal(f.protocol.count('start'), starts); assert.equal(f.protocol.count('create'), 0); assert.equal(f.protocol.count('send'), 0);
  } finally { await f.cleanup(); }
});
