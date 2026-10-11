import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHostNotificationRuntime} from '../src/native-v2/notifications/runtime.mjs';
import {summaryFixture} from '../../galaxy-official/test/personal-summary-workflow.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function memoryStore() {
  const data = new Map(); let tail = Promise.resolve();
  return {data, hook: null, async get(key) { return structuredClone(data.get(key) ?? null); },
    update(key, mutate) { const operation = tail.then(async () => { const value = mutate(structuredClone(data.get(key) ?? null)); data.set(key, structuredClone(value)); if (this.hook) await this.hook(key, value); return structuredClone(value); }); tail = operation.catch(() => {}); return operation; }};
}
function fakeChannel() {
  return {available: true, shows: [], withdrawn: [], showHook: null,
    async capabilities() { return {available: this.available, reason: 'synthetic channel unavailable'}; },
    async show(input, options) { this.shows.push(structuredClone(input)); return this.showHook ? this.showHook(input, options) : {state: 'shown', displayed: true, evidence: 'BalloonTipShown', promptId: input.promptId}; },
    async withdraw(promptId) { this.withdrawn.push(promptId); return {ownedProcessClosed: true}; }, async close() { this.closed = true; }};
}
function fixture() {
  const current = {value: {subjectId: 'GUID0000000000000000000000000000', endpoint: 'https://official.example.org', bindingId: randomUUID(), generation: 1}};
  const item = {id: 'room-message:' + randomUUID(), object: {type: 'room', id: randomUUID()}, title: 'PRIVATE TITLE NEVER SENT TO OS', summary: 'PRIVATE SOURCE BODY', read: false, quiet: false, presented: false, interruptiveEligible: true};
  let source = true, dropAck = false;
  const claims = new Map(), acknowledged = new Set(), calls = {query: 0, claim: 0, presented: []}, store = memoryStore(), channel = fakeChannel();
  const inbox = {
    async query() { calls.query++; return {items: source ? [structuredClone(item)] : []}; },
    async claim(input) { calls.claim++; if (!source) throw Error('synthetic_source_withdrawn');
      if (item.quiet || item.read || acknowledged.has(input.id)) return {id: input.id, claimed: false, quiet: item.quiet, presented: acknowledged.has(input.id)};
      const previous = claims.get(input.id); if (previous && previous.claimId !== input.claimId) return {id: input.id, claimed: false};
      claims.set(input.id, input); return {id: input.id, claimed: true, claimId: input.claimId, leaseUntil: new Date((2000000000 + 30) * 1000).toISOString()}; },
    async presented(input) { calls.presented.push(structuredClone(input)); acknowledged.add(input.id); if (dropAck) { dropAck = false; throw Error('synthetic_lost_display_ack'); }
      return {id: input.id, presented: true, acknowledgement: 'client-reported-display', read: false, humanReadChanged: false}; },
  };
  const options = {inbox, channel, getLease: () => current.value, store, deliveryClientId: randomUUID(), now: () => 2000000000};
  return {runtime: createHostNotificationRuntime(options), options, inbox, current, item, calls, store, channel, acknowledged,
    withdrawSource() { source = false; }, loseAck() { dropAck = true; }};
}

test('host notifications default off; unavailable channel gives only current foreground references, no display claim', async () => {
  const f = fixture(); try {
    assert.equal((await f.runtime.check()).state, 'disabled'); assert.equal(f.calls.query, 0);
    assert.throws(() => f.runtime.enable(), /explicit_choice/);
    f.channel.available = false; await f.runtime.enable({}, {confirmed: true});
    const result = await f.runtime.check(); assert.equal(result.state, 'foreground-fallback'); assert.equal(f.calls.claim, 0); assert.equal(f.channel.shows.length, 0);
    assert.equal(result.items[0].object.id, f.item.object.id); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(result.humanReadChanged, false); assert.equal(result.agentCursorChanged, false);
    const restarted = createHostNotificationRuntime(f.options); assert.equal((await restarted.status()).enabled, false); await restarted.dispose();
  } finally { await f.runtime.dispose(); }
});

test('unknown OS acceptance retains exact body-free original claim, never re-shows after restart or opt-out', async () => {
  const f = fixture(); try {
    f.channel.showHook = async () => ({state: 'unknown', reason: 'synthetic accepted but no shown event', displayed: false});
    await f.runtime.enable({}, {confirmed: true}); assert.equal((await f.runtime.check()).state, 'foreground-fallback');
    assert.equal(f.calls.presented.length, 0); await f.runtime.disable();
    const restarted = createHostNotificationRuntime(f.options); await restarted.enable({}, {confirmed: true}); await restarted.check();
    assert.equal(f.channel.shows.length, 1); assert.equal((await restarted.status()).prompts[0].state, 'unknown');
    assert.equal(JSON.stringify([...f.store.data.values()]).includes('PRIVATE'), false);
    assert.equal((await restarted.reconcile()).systemNotificationStarts, 0); assert.equal(f.calls.presented.length, 0); await restarted.dispose();
  } finally { await f.runtime.dispose(); }
});

test('mute or source withdrawal during OS show withdraws generic prompt but preserves actual display receipt without reading a body', async () => {
  const f = fixture(); try {
    f.channel.showHook = async input => { f.withdrawSource(); return {state: 'shown', displayed: true, evidence: 'BalloonTipShown', promptId: input.promptId}; };
    await f.runtime.enable({}, {confirmed: true}); const result = await f.runtime.check();
    assert.equal(result.state, 'displayed-then-withdrawn'); assert.equal(f.channel.withdrawn.length, 1);
    assert.equal(f.calls.presented.length, 1); assert.equal(f.calls.presented[0].claimId, f.inbox && [...f.store.data.values()][0].prompts[0].claims[0].claimId);
    assert.equal(f.item.read, false); assert.equal(JSON.stringify(f.channel.shows).includes('PRIVATE'), false);
  } finally { await f.runtime.dispose(); }
});

test('same subject replacement lease during journal completion dispatches zero system prompts and never exposes another owner journal', async () => {
  const f = fixture(); try {
    await f.runtime.enable({}, {confirmed: true});
    f.store.hook = (_key, value) => { if (value.prompts.length) f.current.value = {...f.current.value, bindingId: randomUUID(), generation: 2}; };
    const result = await f.runtime.check(); assert.equal(result.state, 'binding-changed'); assert.equal(f.channel.shows.length, 0); assert.equal(f.calls.presented.length, 0);
    f.current.value = {...f.current.value, subjectId: 'GUID1111111111111111111111111111'};
    assert.deepEqual((await f.runtime.status()).prompts, []);
  } finally { await f.runtime.dispose(); }
});

test('disable aborts an in-flight owned prompt and waits for disposal, without Agent cursor or human-read changes', async () => {
  const f = fixture(), started = deferred(); try {
    f.channel.showHook = (_input, options) => new Promise(resolve => { started.resolve(); options.signal.addEventListener('abort', () => resolve({state: 'unknown', displayed: false}), {once: true}); });
    await f.runtime.enable({}, {confirmed: true}); const pending = f.runtime.check(); await started.promise;
    const disabled = await f.runtime.disable(); assert.equal(disabled.enabled, false); await pending;
    assert.equal(f.channel.withdrawn.length, 1); assert.equal(f.calls.presented.length, 0); assert.equal(f.item.read, false);
    const close = f.runtime.dispose(); assert.equal(close, f.runtime.dispose()); await close; assert.equal(f.channel.closed, true);
  } finally { await f.runtime.dispose(); }
});

test('lost display ACK reconciles only original claim even after opt-out; it never queries source or shows again', async () => {
  const f = fixture(); try {
    f.loseAck(); await f.runtime.enable({}, {confirmed: true}); await f.runtime.check(); await f.runtime.disable(); f.withdrawSource();
    const before = {query: f.calls.query, claim: f.calls.claim, shows: f.channel.shows.length}, old = f.calls.presented[0];
    const result = await f.runtime.reconcile(); assert.equal(result.systemNotificationStarts, 0);
    assert.deepEqual(f.calls.presented[1], old); assert.deepEqual({query: f.calls.query, claim: f.calls.claim, shows: f.channel.shows.length}, before);
    assert.equal((await f.runtime.status()).prompts[0].presentationAcknowledged, true); assert.equal(f.item.read, false);
  } finally { await f.runtime.dispose(); }
});

test('a system click re-reads only current object pointers, never returns old private text or writes read/cursor state', async () => {
  const f = fixture(), navigations = []; let click;
  await f.runtime.dispose();
  // A channel callback is a protocol double, not a claim a user clicked the OS.
  const channel = fakeChannel();
  const current = createHostNotificationRuntime({...f.options, channel, onNavigate: value => { navigations.push(value); }});
  try {
    channel.showHook = async (input, options) => { click = options.onClicked; return {state: 'shown', displayed: true, evidence: 'BalloonTipShown', promptId: input.promptId}; };
    await current.enable({}, {confirmed: true}); await current.check();
    f.withdrawSource(); await click(); assert.equal(navigations.length, 1); assert.deepEqual(navigations[0].items, []);
    assert.equal(navigations[0].navigation, '/app/notifications'); assert.equal(f.item.read, false);
    assert.equal(JSON.stringify(navigations).includes('PRIVATE'), false);
    f.current.value = {...f.current.value, bindingId: randomUUID(), generation: 3}; await click(); assert.equal(navigations.length, 1);
  } finally { await current.dispose(); }
});

test('actual HTTP and signed Binding/PGlite inbox merges current events, arbitrates two clients, and keeps human read separate from display', async () => {
  // The OS and local journal are explicit doubles. Real HTTP/Binding/SQL and
  // current room source checks run here; no real OS delivery or Prosody claim.
  const f = await summaryFixture(), channelA = fakeChannel(), channelB = fakeChannel();
  const api = createApi({access: f.chat.access, bindings: {endpoint: f.chat.access.endpoint}, inbox: f.inbox, rateLimit: 1000});
  let a, b;
  try {
    const [sender, recipient] = f.people;
    await f.chat.send(sender, f.roomId, {clientMessageId: randomUUID(), text: 'Another private source must stay out of OS text'});
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`, calls = [];
    const call = async (method, input) => { calls.push(method); const response = await fetch(origin + '/v2/notifications/' + method,
      {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + f.credentials.get(recipient.subjectId)}, body: JSON.stringify(input)});
      const body = await response.json(); if (!response.ok) throw Error(body.error?.code ?? body.error ?? 'HTTP rejection'); return body; };
    const inbox = {query: input => call('query', input), claim: input => call('presentation/claim', input), presented: input => call('presentation/ack', input)};
    const options = {inbox, getLease: () => ({subjectId: recipient.subjectId, endpoint: f.chat.access.endpoint, bindingId: recipient.bindingId, generation: 1}), now: f.now};
    a = createHostNotificationRuntime({...options, channel: channelA, store: memoryStore(), deliveryClientId: randomUUID()});
    b = createHostNotificationRuntime({...options, channel: channelB, store: memoryStore(), deliveryClientId: randomUUID()});
    await a.enable({}, {confirmed: true}); await b.enable({}, {confirmed: true}); await Promise.all([a.check(), b.check()]);
    const shownIds = (await Promise.all([a.status(), b.status()])).flatMap(value => value.prompts.flatMap(prompt => prompt.notificationIds));
    assert.equal(shownIds.length, new Set(shownIds).size, 'Each original event was claimed by only one installation');
    assert.equal(shownIds.length, 2); assert.ok(channelA.shows.length + channelB.shows.length <= 2);
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM notification_reads WHERE subject_id=$1', [recipient.subjectId])).rows[0].n), 0);
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM notification_presentations WHERE subject_id=$1 AND presented_at IS NOT NULL', [recipient.subjectId])).rows[0].n), 2);
    await f.inbox.saveOptions(recipient, {expectedRevision: 0, settings: {mutedRoomIds: [f.roomId]}}); await a.check(); await b.check();
    const count = channelA.shows.length + channelB.shows.length;
    await f.chat.send(sender, f.roomId, {clientMessageId: randomUUID(), text: 'Muted ordinary event'}); await a.check(); await b.check();
    assert.equal(channelA.shows.length + channelB.shows.length, count);
    assert.ok(calls.includes('presentation/ack')); assert.equal(JSON.stringify([...channelA.shows, ...channelB.shows]).includes('private'), false);
  } finally { await a?.dispose(); await b?.dispose(); await new Promise(resolve => api.close(resolve)); await f.close(); }
});
