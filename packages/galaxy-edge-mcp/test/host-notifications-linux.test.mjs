import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLinuxNotificationChannel } from '../src/native-v2/notifications/linux-freedesktop.mjs';
import { createHostNotificationRuntime } from '../src/native-v2/notifications/runtime.mjs';

const fixturePath = fileURLToPath(new URL('./host-notifications-linux-process-fixture.mjs', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Real owned Node children exercise pipe/exit/abort/drain. The replacement is
// explicit: this is not Python/GIO, a Linux desktop daemon, or a shown popup.
function channelFixture({ scenario = 'normal', checkExecutable = async () => {}, timeoutMs = 5000, shutdownGraceMs = 500 } = {}) {
  const starts = [], processes = [], firstSpawn = deferred();
  const channel = createLinuxNotificationChannel({ platform: 'linux', checkExecutable, timeoutMs, shutdownGraceMs,
    spawnProcess(command, args, options) {
      assert.equal(command, '/usr/bin/python3');
      assert.equal(args.length, 3); assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
      assert.equal(typeof args[2], 'string'); assert.ok(args[2].includes('Gio.DBusConnection.new_for_address_sync'));
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      const child = spawn(process.execPath, [fixturePath, scenario], options);
      const entry = { inputs: [], closed: false, child };
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (data, ...rest) => { entry.inputs.push(JSON.parse(String(data))); return write(data, ...rest); };
      entry.exit = new Promise(resolve => child.once('exit', () => { entry.closed = true; resolve(); }));
      starts.push({ command, args: args.slice(0, 2), shell: options.shell }); processes.push(entry); firstSpawn.resolve();
      return child;
    },
  });
  return { channel, starts, processes, firstSpawn: firstSpawn.promise,
    shows: () => processes.flatMap(entry => entry.inputs).filter(value => value.mode === 'show'),
    async close() { await channel.close(); await Promise.all(processes.map(entry => entry.exit)); assert.ok(processes.every(entry => entry.closed)); },
  };
}

test('Linux channel construction is inert, unsupported hosts start nothing, and inputs cannot become shell arguments', async () => {
  let starts = 0, checks = 0;
  const channel = createLinuxNotificationChannel({ platform: 'win32', spawnProcess() { starts++; throw Error('must not start'); }, checkExecutable: async () => { checks++; } });
  try {
    assert.equal(starts, 0); assert.equal(checks, 0);
    assert.equal(channel.kind, 'linux-freedesktop');
    assert.equal((await channel.capabilities()).available, false);
    assert.equal((await channel.show({ promptId: randomUUID(), eventCount: 1 })).state, 'unavailable');
    assert.equal(starts, 0); assert.equal(checks, 0);
    assert.throws(() => createLinuxNotificationChannel({ command: 'python3;anything' }), /must_be_absolute/);
    assert.throws(() => createLinuxNotificationChannel({ timeoutMs: 30001 }), /timeout_invalid/);
    assert.throws(() => channel.show({ promptId: 'bad;input', eventCount: 1 }), /prompt_invalid/);
  } finally { await channel.close(); }
});

test('read-only capabilities run one fixed helper without a notification request or private material', async () => {
  const f = channelFixture();
  try {
    const capability = await f.channel.capabilities();
    assert.deepEqual(capability, { available: true, channel: 'linux-freedesktop', displayEvidence: 'none', permission: 'system-managed', recall: 'same-connection-original-id', processStarted: true });
    assert.equal(f.starts.length, 1); assert.deepEqual(f.processes[0].inputs, [{ mode: 'probe' }]); assert.equal(f.shows().length, 0);
  } finally { await f.close(); }
});

test('Notify acceptance remains unknown; exact prompt is not repeated and original owned connection closes on withdrawal', async () => {
  const f = channelFixture(), promptId = randomUUID();
  try {
    const input = { promptId, eventCount: 2, text: 'PRIVATE SYNTHETIC BODY', url: 'https://private.example/secret' };
    const first = f.channel.show(input), duplicate = f.channel.show(input);
    assert.equal(first, duplicate);
    const result = await first;
    assert.equal(result.state, 'unknown'); assert.equal(result.systemAccepted, true); assert.equal(result.displayed, false);
    assert.equal(result.foregroundFallbackRequired, true); assert.equal(result.humanReadChanged, false); assert.equal(result.agentCursorChanged, false);
    assert.deepEqual(f.shows(), [{ mode: 'show', eventCount: 2 }]);
    assert.equal(JSON.stringify(f.processes[0].inputs).includes('PRIVATE'), false);
    const stopped = await f.channel.withdraw(promptId);
    assert.equal(stopped.ownedProcessClosed, true); assert.equal(stopped.systemRecall, 'requested-original-id');
    assert.equal(stopped.humanReadChanged, false); assert.equal(stopped.agentCursorChanged, false);
    assert.equal(f.starts.length, 1); assert.equal(f.processes[0].closed, true);
  } finally { await f.close(); }
});

test('lost daemon owner is unconfirmed withdrawal, without a new process or another notification ID', async () => {
  const f = channelFixture({ scenario: 'owner-lost' }), promptId = randomUUID();
  try {
    assert.equal((await f.channel.show({ promptId, eventCount: 1 })).systemAccepted, true);
    const result = await f.channel.withdraw(promptId);
    assert.equal(result.systemRecall, 'unconfirmed'); assert.equal(result.ownedProcessClosed, true);
    assert.equal(f.starts.length, 1); assert.equal(f.shows().length, 1);
    assert.deepEqual(f.processes[0].inputs.at(-1), { mode: 'close' });
  } finally { await f.close(); }
});

test('a live child error is not exit evidence; abort still waits for the original process to close', async () => {
  const f = channelFixture(), promptId = randomUUID(), abort = new AbortController(); let closed = 0;
  try {
    await f.channel.show({ promptId, eventCount: 1 }, { signal: abort.signal, onClosed: () => { closed++; } });
    const process = f.processes[0]; process.child.emit('error', Error('synthetic late child error'));
    assert.equal(process.closed, false); assert.equal(closed, 0);
    abort.abort(); await f.channel.withdraw(promptId);
    assert.equal(process.closed, true); assert.equal(closed, 1); assert.equal(f.starts.length, 1);
  } finally { await f.close(); }
});

test('late lease loss withholds acceptance and drains the original process; abort and close do not create another helper', async () => {
  const f = channelFixture({ scenario: 'late' }), promptId = randomUUID(); let current = true;
  try {
    const pending = f.channel.show({ promptId, eventCount: 1 }, { isCurrent: () => current });
    await f.firstSpawn; current = false;
    const result = await pending;
    assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'notification_cancelled'); assert.equal(result.systemAccepted, undefined);
    await f.channel.withdraw(promptId); assert.equal(f.starts.length, 1); assert.equal(f.processes[0].closed, true);
  } finally { await f.close(); }
  const gate = deferred(), entered = deferred(), held = channelFixture({ checkExecutable: async () => { entered.resolve(); await gate.promise; } });
  const pending = held.channel.show({ promptId: randomUUID(), eventCount: 1 }); await entered.promise;
  const closed = held.channel.close(); assert.equal(closed, held.channel.close()); await closed;
  gate.resolve(); assert.equal((await pending).state, 'unknown'); await held.close(); assert.equal(held.starts.length, 0);
});

test('malformed display claims, oversized output, unavailable service and a hung process never create a display receipt', async () => {
  for (const scenario of ['malformed', 'oversize', 'unavailable', 'hang']) {
    const f = channelFixture({ scenario, timeoutMs: scenario === 'hang' ? 300 : 5000, shutdownGraceMs: 150 });
    try {
      const result = await f.channel.show({ promptId: randomUUID(), eventCount: 1 });
      assert.equal(result.displayed, false); assert.notEqual(result.state, 'shown'); assert.equal(result.systemAccepted, undefined);
      assert.equal(result.reason, scenario === 'unavailable' ? 'linux_notification_service_unavailable' : scenario === 'hang' ? 'notification_process_timeout' : 'notification_protocol_invalid');
    } finally { await f.close(); }
    assert.equal(f.processes[0].closed, true);
  }
});

test('pending helper reservation is bounded before asynchronous executable inspection and close releases all unsent attempts', async () => {
  const gate = deferred(), f = channelFixture({ checkExecutable: () => gate.promise });
  const pending = Array.from({ length: 64 }, () => f.channel.show({ promptId: randomUUID(), eventCount: 1 }));
  assert.equal((await f.channel.show({ promptId: randomUUID(), eventCount: 1 })).reason, 'notification_process_capacity');
  await f.channel.close(); gate.resolve();
  assert.ok((await Promise.all(pending)).every(value => value.state === 'unknown')); assert.equal(f.starts.length, 0); await f.close();
});

function runtimeFixture(channel) {
  const lease = { subjectId: 'GUID0000000000000000000000000000', endpoint: 'https://official.example.org', bindingId: randomUUID(), generation: 1 };
  const item = { id: 'room-message:' + randomUUID(), object: { type: 'room', id: randomUUID() }, title: 'PRIVATE SYNTHETIC TITLE', summary: 'PRIVATE SOURCE BODY', read: false, quiet: false, presented: false, interruptiveEligible: true };
  const data = new Map(); let tail = Promise.resolve(), source = true;
  const counts = { query: 0, claim: 0, presented: 0 };
  const store = { async get(key) { return structuredClone(data.get(key) ?? null); }, update(key, mutate) {
    const operation = tail.then(() => { const value = mutate(structuredClone(data.get(key) ?? null)); data.set(key, structuredClone(value)); return structuredClone(value); }); tail = operation.catch(() => {}); return operation;
  } };
  const inbox = { async query() { counts.query++; return { items: source ? [structuredClone(item)] : [] }; }, async claim(input) {
    counts.claim++;
    return { id: input.id, claimed: source && !item.quiet, claimId: input.claimId, quiet: item.quiet, leaseUntil: new Date(2000000030 * 1000).toISOString() };
  }, async presented() { counts.presented++; throw Error('Linux acceptance must never be acknowledged as display'); } };
  const options = { inbox, channel, store, getLease: () => lease, deliveryClientId: randomUUID(), now: () => 2000000000 };
  return { runtime: createHostNotificationRuntime(options), options, counts, item, data, withdrawSource() { source = false; } };
}

test('explicit opt-in and unknown journal prevent re-show after opt-out/restart; Linux Notify reply writes no presented/read/cursor', async () => {
  const child = channelFixture(), f = runtimeFixture(child.channel); let restarted;
  try {
    assert.equal((await f.runtime.check()).state, 'disabled'); assert.equal(child.starts.length, 0); assert.equal(f.counts.query, 0);
    await f.runtime.enable({}, { confirmed: true });
    const result = await f.runtime.check();
    assert.equal(result.state, 'foreground-fallback'); assert.equal(result.systemDisplayConfirmed, false);
    assert.equal(result.humanReadChanged, false); assert.equal(result.agentCursorChanged, false); assert.equal(f.counts.presented, 0);
    assert.deepEqual(child.shows(), [{ mode: 'show', eventCount: 1 }]); assert.equal(JSON.stringify([...f.data.values()]).includes('PRIVATE'), false);
    assert.equal((await f.runtime.status()).prompts[0].state, 'unknown');
    await f.runtime.disable(); restarted = createHostNotificationRuntime(f.options); await restarted.enable({}, { confirmed: true });
    assert.equal((await restarted.check()).state, 'no-new-items'); assert.equal(child.shows().length, 1);
    assert.equal((await restarted.reconcile()).systemNotificationStarts, 0); assert.equal(f.counts.presented, 0); assert.equal(f.item.read, false);
  } finally { await restarted?.dispose(); await f.runtime.dispose(); await child.close(); }
});

test('source withdrawal after unconfirmed Notify acceptance closes the still owned original helper without a new notification', async () => {
  const child = channelFixture(), f = runtimeFixture(child.channel);
  try {
    await f.runtime.enable({}, { confirmed: true }); await f.runtime.check();
    const owned = child.processes.find(entry => entry.inputs.some(input => input.mode === 'show'));
    assert.ok(owned); assert.equal(owned.closed, false);
    f.withdrawSource(); await f.runtime.check();
    assert.equal(owned.closed, true, 'Current source loss must retain and withdraw the original accepted-but-unconfirmed process');
    assert.equal(child.shows().length, 1); assert.equal(f.counts.presented, 0); assert.equal(f.item.read, false);
  } finally { await f.runtime.dispose(); await child.close(); }
});

test('quiet/current source loss and missing Linux daemon keep current foreground fallback without dispatch or display ACK', async () => {
  const child = channelFixture(), f = runtimeFixture(child.channel);
  try {
    f.item.quiet = true; await f.runtime.enable({}, { confirmed: true }); await f.runtime.check();
    assert.equal(child.shows().length, 0); f.item.quiet = false; f.withdrawSource();
    assert.equal((await f.runtime.check()).state, 'no-new-items'); assert.equal(child.shows().length, 0); assert.equal(f.counts.presented, 0);
  } finally { await f.runtime.dispose(); await child.close(); }
  const absent = channelFixture({ scenario: 'unavailable' }), g = runtimeFixture(absent.channel);
  // Read-only probing succeeds in this fixture; show then reports unavailable.
  try {
    await g.runtime.enable({}, { confirmed: true }); const result = await g.runtime.check();
    assert.equal(result.state, 'foreground-fallback'); assert.equal(result.reason, 'linux_notification_service_unavailable');
    assert.equal(result.items[0].object.id, g.item.object.id); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(g.counts.presented, 0); assert.equal(g.item.read, false);
  } finally { await g.runtime.dispose(); await absent.close(); }
});
