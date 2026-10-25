import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWatchRuntime } from '../src/native-v2/watch/runtime.mjs';

test('stopping during a source read suppresses later host work and leaves no timer', async () => {
  let release; const timers = [], works = [];
  const watch = {
    check: () => new Promise(resolve => { release = resolve; }),
    status: async () => ({ items: [{ id: 'a', state: 'active', nextCheckAt: 1000 }, { id: 'b', state: 'active' }] }),
    stop: async () => ({ state: 'stopped' }),
  };
  const runtime = createNativeWatchRuntime({ watch, now: () => 100,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancelSchedule: timer => { timer.canceled = true; }, onWork: async work => works.push(work) });
  await runtime.activate('a', { checkNow: false });
  assert.deepEqual((await runtime.status()).items.map(row => row.hostState), ['running-host', 'suspended-host']);
  const reading = runtime.check('a');
  await runtime.stop('a');
  release({ state: 'work-ready', work: { workId: 'late' } });
  assert.equal((await reading).workSuppressed, true);
  assert.equal(works.length, 0);
  assert.equal(timers.filter(timer => !timer.canceled).length, 0);
  await runtime.dispose();
});

test('watch runtime uses host events, bounded fallback, and explicit ack without model calls', async () => {
  const now = 1000;
  const timers = [];
  let eventHandler;
  let checks = 0;
  let acks = 0;
  const watch = {
    async check(id, options = {}) {
      checks++;
      assert.equal(id, 'watch-1');
      if (options.force) return { state: 'work-ready', modelCalls: 0, work: { workId: 'work-1' } };
      return { state: 'unchanged', modelCalls: 0 };
    },
    async status() { return { items: [{ id: 'watch-1', state: 'active', nextCheckAt: now + 900 }] }; },
    async ack(_id, workId) { acks++; assert.equal(workId, 'work-1'); return { state: 'processed', humanRead: false }; },
    async stop(id) { return { id, state: 'stopped' }; },
  };
  const works = [];
  const runtime = createNativeWatchRuntime({ watch, now: () => now, fallbackSeconds: 900,
    eventSource: { subscribe(handler) { eventHandler = handler; return () => { eventHandler = null; }; } },
    schedule(fn, delay) { timers.push({ fn, delay }); return timers.length - 1; },
    cancelSchedule(handle) { timers[handle].canceled = true; },
    onWork: async item => works.push(item),
  });
  const activated = await runtime.activate('watch-1');
  assert.equal(activated.runtime.eventDriven, true);
  assert.equal(checks, 1);
  assert.equal(timers.length, 1);
  eventHandler({ watchId: 'watch-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  assert.equal(works.length, 1);
  assert.equal(works[0].result.modelCalls, 0);
  await runtime.ack('watch-1', 'work-1');
  assert.equal(acks, 1);
  await runtime.stop('watch-1');
  await runtime.dispose();
});

test('watch runtime retries scheduling after a transient status failure', async () => {
  const timers = [];
  let statusCalls = 0;
  const watch = {
    async check() { return { state: 'unchanged', modelCalls: 0 }; },
    async status() { statusCalls++; if (statusCalls === 1) throw new Error('temporary network failure'); return { items: [{ id: 'watch-2', state: 'active', nextCheckAt: 100 }] }; },
    async stop() { return { state: 'stopped' }; },
  };
  const runtime = createNativeWatchRuntime({ watch, fallbackSeconds: 60,
    schedule(fn, delay) { timers.push({ fn, delay }); return timers.length - 1; },
    cancelSchedule() {} });
  await runtime.activate('watch-2', { checkNow: false });
  assert.equal(statusCalls, 2);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60000);
  await runtime.stop('watch-2');
});

test('dispose shares its drain for a check detached by pause and an in-flight ACK', async () => {
  let releaseCheck, releaseAck;
  const timers = [], delivered = [];
  const watch = {
    check: () => new Promise(resolve => { releaseCheck = resolve; }),
    ack: () => new Promise(resolve => { releaseAck = resolve; }),
    status: async () => ({ items: [{ id: 'a', state: 'active', nextCheckAt: 1000 }, { id: 'b', state: 'active', nextCheckAt: 1000 }] }),
    pause: async () => ({ state: 'paused' }),
  };
  const runtime = createNativeWatchRuntime({ watch, now: () => 100,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancelSchedule: timer => { timer.canceled = true; }, onWork: item => delivered.push(item) });
  await runtime.activate('a', { checkNow: false }); await runtime.activate('b', { checkNow: false });
  const checking = runtime.check('a'), acknowledging = runtime.ack('b', 'work');
  await new Promise(resolve => setImmediate(resolve)); await runtime.pause('a');
  const first = runtime.dispose(); assert.equal(first, runtime.dispose());
  let ended = false; first.then(() => { ended = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  releaseCheck({ state: 'work-ready', work: {} }); await checking;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  releaseAck({ state: 'processed', humanRead: false }); await acknowledging; await first;
  assert.equal(delivered.length, 0); assert.equal(timers.filter(timer => !timer.canceled).length, 0);
});

for (const action of ['pause', 'stop']) test('dispose waits for a detached '+action+' revocation receipt', async () => {
  let release;
  const watch = { check: async () => ({}), status: async () => ({ items: [{ id: 'a', state: 'active', nextCheckAt: 1000 }] }),
    [action]: () => new Promise(resolve => { release = resolve; }) };
  const runtime = createNativeWatchRuntime({ watch, now: () => 100, schedule: () => 1, cancelSchedule: () => {} });
  await runtime.activate('a', { checkNow: false }); const halted = runtime[action]('a');
  const closing = runtime.dispose(); let ended = false; closing.then(() => { ended = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  release({ state: action === 'pause' ? 'paused' : 'stopped', remoteGrantRevoked: true }); await halted; await closing;
});
