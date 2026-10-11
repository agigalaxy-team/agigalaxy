import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHostNotificationRuntime } from '../src/native-v2/notifications/runtime.mjs';

// Channel and inbox protocol doubles isolate retained ownership of an accepted
// OS request. They do not claim Linux desktop display or physical dismissal.
function fixture({ wrongPrompt = false, closesImmediately = false } = {}) {
  const lease = { subjectId: 'GUID' + 'A'.repeat(28), endpoint: 'https://official.example.org', bindingId: randomUUID(), generation: 1 };
  const item = { id: 'room-message:' + randomUUID(), object: { type: 'room', id: randomUUID() },
    interruptiveEligible: true, quiet: false, read: false, presented: false };
  const values = new Map(), counts = { shows: 0, displayedAcks: 0, closed: 0 }, withdrawn = [];
  let source = true, serial = Promise.resolve();
  const channel = { kind: 'linux-freedesktop', async capabilities() { return { available: true, channel: this.kind }; },
    async show(input, options) { counts.shows++; if (closesImmediately) options.onClosed();
      return { state: 'unknown', displayed: false, systemAccepted: true, promptId: wrongPrompt ? randomUUID() : input.promptId }; },
    async withdraw(id) { withdrawn.push(id); return { ownedProcessClosed: true }; }, async close() { counts.closed++; } };
  const runtime = createHostNotificationRuntime({ channel, getLease: () => lease, now: () => 2000000000, deliveryClientId: randomUUID(),
    store: { get: async key => structuredClone(values.get(key)), update(key, change) {
      const run = serial.then(() => { const value = change(structuredClone(values.get(key))); values.set(key, structuredClone(value)); return value; });
      serial = run.catch(() => {}); return run;
    } }, inbox: { async query() { return { items: source ? [item] : [] }; }, async claim(input) {
      return { id: input.id, claimId: input.claimId, claimed: source && !item.quiet, quiet: item.quiet, leaseUntil: new Date(2000000030 * 1000).toISOString() };
    }, async presented() { counts.displayedAcks++; throw Error('OS acceptance is not display'); } } });
  return { runtime, counts, withdrawn, values, item, removeSource() { source = false; } };
}

test('an accepted unknown system prompt remains withdrawable on later source loss without claiming display', async () => {
  const f = fixture();
  try {
    await f.runtime.enable({}, { confirmed: true });
    assert.equal((await f.runtime.check()).state, 'foreground-fallback');
    const original = (await f.runtime.status()).prompts[0].promptId;
    f.removeSource(); await f.runtime.check();
    assert.deepEqual(f.withdrawn, [original]); assert.equal(f.counts.shows, 1); assert.equal(f.counts.displayedAcks, 0);
    assert.equal((await f.runtime.status()).prompts[0].state, 'unknown');
    assert.equal((await f.runtime.reconcile()).systemNotificationStarts, 0); assert.equal(f.counts.displayedAcks, 0);
  } finally { await f.runtime.dispose(); }
});

test('Linux enable identifies the selected channel and disable withdraws only its exact accepted prompt', async () => {
  const f = fixture();
  try {
    assert.equal((await f.runtime.enable({}, { confirmed: true })).channel, 'linux-freedesktop');
    await f.runtime.check(); const original = (await f.runtime.status()).prompts[0].promptId;
    await f.runtime.disable(); assert.deepEqual(f.withdrawn, [original]);
    assert.equal(f.counts.displayedAcks, 0); assert.equal(f.item.read, false);
  } finally { await f.runtime.dispose(); }
});

test('mismatched accepted IDs and already closed system prompts are not retained for later withdrawal', async () => {
  for (const options of [{ wrongPrompt: true }, { closesImmediately: true }]) {
    const f = fixture(options);
    try {
      await f.runtime.enable({}, { confirmed: true }); await f.runtime.check(); f.removeSource(); await f.runtime.check();
      assert.deepEqual(f.withdrawn, []); assert.equal(f.counts.displayedAcks, 0);
    } finally { await f.runtime.dispose(); }
  }
});
