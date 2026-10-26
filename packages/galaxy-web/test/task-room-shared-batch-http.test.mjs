import test from 'node:test';
import { retainTaskContactAgent, taskContactWebsite } from './task-contact-agent-fixture.mjs';
import assert from 'node:assert/strict';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { oidcProviderFixture } from '../../galaxy-official/test/oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from "../../galaxy-official/src/identity/authentication/oidc-login.mjs";
import { createApi } from '../../galaxy-official/src/http.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { createExistingWebRuntime, confirmFixtureAccountLink } from '../../galaxy-official/test/existing-web-identity-fixture.mjs';
import { taskDraft, publicationFromDraft } from "../src/features/tasks/task-bounty-client.mjs";
import { createTaskContactClient } from "../src/features/tasks/contact/task-contact-client.mjs";

const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
// A single-process clone Map transaction controls real reads and HTTP ACKs.
// It does not stand in for independently verified two-tab IndexedDB exclusion.
function memoryStore() {
  const values = new Map(); let gate;
  return {
    setGate(value) { gate = value; },
    async get(key) {
      const value = structuredClone(values.get(key));
      if (gate?.key === key && gate.tickets.length) {
        const ticket = gate.tickets.shift(); ticket.hit.resolve(value); await ticket.release.promise;
      }
      return value;
    },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async update(key, updater) {
      const next = updater(structuredClone(values.get(key)));
      if (next && typeof next.then === 'function') throw Error('synchronous_update_required');
      values.set(key, structuredClone(next)); return structuredClone(next);
    },
  };
}
async function fixtureRun(run) {
  const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  const runtimes = []; let f, server, responseGate;
  const creates = [], proposals = [], consents = [];
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic M11 Room OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
    f = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
    server = createApi({ ...f, rateLimit: 3000 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const wire = async (url, init) => {
      const path = new URL(url).pathname, response = await fetch(origin + path, init);
      if (path === '/v1/consents') consents.push(JSON.parse(init.body));
      const kind = path === '/v2/chat/rooms/create' ? 'create' : /^\/v2\/chat\/rooms\/.+\/propose$/.test(path) ? 'propose' : null;
      if (kind) {
        (kind === 'create' ? creates : proposals).push({ path, input: JSON.parse(init.body), status: response.status });
        if (responseGate?.kind === kind) {
          const selected = responseGate; responseGate = null;
          assert.equal(response.status, 200); selected.hit.resolve(); await selected.release.promise;
          if (selected.lose) throw Error('lost exact original Room ACK');
        }
      }
      return response;
    };
    const stores = new WeakMap();
    const ownerStore = memoryStore(), make = async (store = memoryStore()) => {
      const rt = await createExistingWebRuntime({ endpoint, trustedKeys: f.bindings.trustedKeys }, { store, fetch: wire, now: () => now, website: taskContactWebsite });
      stores.set(rt, store);
      runtimes.push(rt); return rt;
    };
    const a = await make(ownerStore), b = await make(), c = await make();
    for (const rt of [a, b, c]) { await rt.connect({ confirmed: true }); await retainTaskContactAgent(rt, stores.get(rt), now); }
    for (const { rt, account } of [{ rt: a, account: 'owner' }, { rt: b, account: 'recipient-b' }, { rt: c, account: 'recipient-c' }]) {
      issuer.setAccount('synthetic-m11-room-' + account);
      const login = await rt.api.call('/v1/identity/begin', { providerId: 'fixture' }), callback = await issuer.authorize(login.authorizationUrl);
      assert.equal((await fetch(origin + callback.pathname + callback.search)).status, 200);
      await confirmFixtureAccountLink(rt, login.loginId);
    }
    const { taskId } = await a.publishTask(publicationFromDraft(taskDraft({ title: 'M11 exact displayed Room plan',
      summary: 'Synthetic isolated fixture', goal: 'Confirm original recipients and mode', situation: 'Concurrent local runtimes',
      visibility: 'Public', intent: 'diagnosis' }, now), [], now), { confirmed: true });
    const read = () => a.api.call(`/v2/tasks/${taskId}`, null, { method: 'GET' });
    const clientA = createTaskContactClient(a, taskId), bid = b.api.snapshot().subjectId, cid = c.api.snapshot().subjectId;
    const invites = await clientA.prepareInvites([{ subjectId: bid, note: 'Discuss exact Task B' }, { subjectId: cid, note: 'Discuss exact Task C' }]);
    assert.ok((await clientA.sendInvites({ confirmed: true, batchId: invites.batchId })).items.every(item => item.state === 'acknowledged'));
    for (const [rt, index] of [[b, 0], [c, 1]]) {
      const current = await read();
      await rt.taskEvent(taskId, { kind: 'invitation-reply', invitationId: invites.items[index].eventId,
        expectedTaskVersion: current.version, response: 'interested', message: 'Discussion interest is not Task participation' },
      { confirmed: true, viewers: [a.api.snapshot().subjectId] });
    }
    const a2 = await make(ownerStore); await a2.connect({ confirmed: true });
    const clientB = createTaskContactClient(a2, taskId);
    await run({ a, a2, b, c, bid, cid, taskId, read, ownerStore, clientA, clientB, creates, proposals, consents,
      localKey: `galaxy-web:${endpoint}:${a.api.snapshot().subjectId}:task-room-batch:${taskId}`,
      setResponseGate: value => { responseGate = value; } });
    const current = await read(); assert.equal(current.caseId, null); assert.equal(current.participations.length, 0);
  } finally {
    responseGate?.release.resolve();
    for (const rt of runtimes) rt.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (f) await f.db.close(); await issuer.close();
  }
}

test('Room atomic claim preserves displayed recipients/mode and rejects missing or stale IDs before any Room write', { timeout: 90000 }, () => fixtureRun(async f => {
  const first = { hit: deferred(), release: deferred() }, second = { hit: deferred(), release: deferred() };
  f.ownerStore.setGate({ key: f.localKey, tickets: [first, second] });
  const p1 = f.clientA.prepareRooms('separate', [f.bid]); await first.hit.promise;
  const p2 = f.clientB.prepareRooms('together', [f.bid, f.cid]);
  const rejected = assert.rejects(p2, /原房间批次/); await second.hit.promise;
  first.release.resolve(); const original = await p1;
  second.release.resolve(); await rejected; f.ownerStore.setGate(null);
  const stored = await f.clientB.pendingRooms(); assert.equal(stored.batchId, original.batchId);
  assert.equal(stored.mode, 'separate'); assert.deepEqual(stored.rooms[0].invitations.map(item => item.subjectId), [f.bid]);
  const before = f.consents.length;
  await assert.rejects(f.clientA.sendRooms({ confirmed: true }), error => error.code === 'task_room_batch_id_required');
  await assert.rejects(f.clientA.sendRooms({ confirmed: true, batchId: crypto.randomUUID() }), error => error.code === 'task_room_batch_changed');
  await assert.rejects(f.clientA.cancelPreparedRooms({ batchId: crypto.randomUUID() }), error => error.code === 'task_room_batch_changed');
  assert.equal(f.creates.length, 0); assert.equal(f.proposals.length, 0); assert.equal(f.consents.length, before);
  const sent = await f.clientA.sendRooms({ confirmed: true, batchId: original.batchId });
  assert.equal(sent.rooms[0].state, 'acknowledged'); assert.equal(f.creates[0].input.roomId, original.rooms[0].input.roomId);
  assert.equal(f.proposals[0].input.targetSubjectId, f.bid);
}));

test('late original create ACK cannot replace a newer prepared Room batch or continue old invitations', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareRooms('separate', [f.bid]);
  const gate = { kind: 'create', hit: deferred(), release: deferred(), lose: false }; f.setResponseGate(gate);
  const sending = f.clientA.sendRooms({ confirmed: true, batchId: original.batchId });
  try {
    await gate.hit.promise;
    const ack = await f.clientB.sendRooms({ confirmed: true, batchId: original.batchId });
    assert.equal(ack.rooms[0].state, 'acknowledged');
    const fresh = await f.clientB.prepareRooms('separate', [f.cid]);
    const beforeProposals = f.proposals.length; gate.release.resolve(); await sending;
    const retained = await f.clientB.pendingRooms(); assert.deepEqual(retained, fresh);
    assert.equal(f.proposals.length, beforeProposals);
    assert.deepEqual(f.creates[0].input, f.creates[1].input, 'exact original create retry keeps original IDs and payload');
    assert.equal((await f.a.api.call(`/v2/chat/rooms/${original.rooms[0].input.roomId}/read`, {})).roomId, original.rooms[0].input.roomId);
  } finally { gate.release.resolve(); }
}));

test('late transport unknown cannot downgrade a shared acknowledged Room; unknown decision cannot be refreshed', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareRooms('separate', [f.bid]);
  const gate = { kind: 'propose', hit: deferred(), release: deferred(), lose: true }; f.setResponseGate(gate);
  const sending = f.clientA.sendRooms({ confirmed: true, batchId: original.batchId });
  try {
    await gate.hit.promise;
    const held = await f.clientB.pendingRooms(), before = f.proposals.length;
    await assert.rejects(f.clientB.refreshRoomPlan(original.rooms[0].input.roomId), /原操作待核对|未知操作/);
    assert.deepEqual(await f.clientB.pendingRooms(), held); assert.equal(f.proposals.length, before);
    const ack = await f.clientB.sendRooms({ confirmed: true, batchId: original.batchId });
    assert.equal(ack.rooms[0].state, 'acknowledged');
    gate.release.resolve(); const late = await sending;
    assert.equal(late.rooms[0].state, 'acknowledged'); assert.equal(late.rooms[0].invitations[0].state, 'acknowledged');
    assert.equal((await f.clientB.pendingRooms()).rooms[0].state, 'acknowledged');
    assert.equal(f.creates.length, 1); assert.equal(f.proposals.length, 2);
    assert.deepEqual(f.proposals[0].input, f.proposals[1].input);
  } finally { gate.release.resolve(); }
}));

test('cancel only clears its exact unsent plan; stale reads, reconnect and missing atomic capability keep replacement', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareRooms('separate', [f.bid]);
  const waiting = { hit: deferred(), release: deferred() };
  f.ownerStore.setGate({ key: f.localKey, tickets: [waiting] });
  const cancelling = f.clientA.cancelPreparedRooms({ batchId: original.batchId });
  const rejected = assert.rejects(cancelling, error => error.code === 'task_room_batch_changed');
  await waiting.hit.promise;
  await f.clientB.cancelPreparedRooms({ batchId: original.batchId });
  const fresh = await f.clientB.prepareRooms('separate', [f.cid]);
  waiting.release.resolve(); await rejected; f.ownerStore.setGate(null);
  assert.deepEqual(await f.clientB.pendingRooms(), fresh);
  const noAtomic = createTaskContactClient({ ...f.a2, updateLocal: undefined }, f.taskId);
  await assert.rejects(noAtomic.sendRooms({ confirmed: true, batchId: fresh.batchId }), /local_atomic_update_unavailable/);
  await f.a.connect({ confirmed: true });
  await assert.rejects(f.clientA.sendRooms({ confirmed: true, batchId: fresh.batchId }), /身份或连接已改变/);
  assert.equal(f.creates.length, 0); assert.equal(f.proposals.length, 0);
  await f.clientB.cancelPreparedRooms({ batchId: fresh.batchId }); assert.equal(await f.clientB.pendingRooms(), null);
}));

test('current member refresh creates a new displayed batch while preserving original room and decision history', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareRooms('together', [f.bid, f.cid]);
  const sent = await f.clientA.sendRooms({ confirmed: true, batchId: original.batchId }), room = sent.rooms[0];
  assert.equal(room.state, 'waiting-for-members'); assert.equal(room.invitations[1].state, 'queued');
  const path = `/v2/chat/rooms/${room.input.roomId}`;
  await f.b.api.call(path + '/accept', { decisionId: room.invitations[0].decisionId, accept: true });
  const refreshed = await f.clientA.refreshRoomPlan(room.input.roomId);
  assert.notEqual(refreshed.batchId, original.batchId); assert.deepEqual(refreshed.rooms[0].input, room.input);
  assert.equal(refreshed.rooms[0].invitations[0].decisionId, room.invitations[0].decisionId);
  assert.equal(refreshed.rooms[0].invitations[1].decisionId, room.invitations[1].decisionId);
  const before = f.proposals.length;
  await assert.rejects(f.clientA.sendRooms({ confirmed: true, batchId: original.batchId }), error => error.code === 'task_room_batch_changed');
  await assert.rejects(f.clientA.cancelPreparedRooms({ batchId: original.batchId }), error => error.code === 'task_room_batch_changed');
  assert.equal(f.proposals.length, before);
  const final = await f.clientA.sendRooms({ confirmed: true, batchId: refreshed.batchId }), second = final.rooms[0].invitations[1];
  await f.b.api.call(path + '/vote', { decisionId: second.decisionId, choice: 'approve' });
  await f.c.api.call(path + '/accept', { decisionId: second.decisionId, accept: true });
  const compareSubjectIds = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  assert.deepEqual((await f.a.api.call(path + '/read', {})).members.map(item => item.subjectId).sort(compareSubjectIds), [f.a.api.snapshot().subjectId, f.bid, f.cid].sort(compareSubjectIds));
  assert.equal(f.creates.length, 1);
}));

test('late original ACK keeps a newer unknown create journal as well as its exact Room batch', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareRooms('separate', [f.bid]);
  const oldGate = { kind: 'create', hit: deferred(), release: deferred(), lose: false }; f.setResponseGate(oldGate);
  const oldSend = f.clientA.sendRooms({ confirmed: true, batchId: original.batchId });
  let newGate, newSend;
  try {
    await oldGate.hit.promise;
    assert.equal((await f.clientB.sendRooms({ confirmed: true, batchId: original.batchId })).rooms[0].state, 'acknowledged');
    const fresh = await f.clientB.prepareRooms('separate', [f.cid]);
    newGate = { kind: 'create', hit: deferred(), release: deferred(), lose: true }; f.setResponseGate(newGate);
    newSend = f.clientB.sendRooms({ confirmed: true, batchId: fresh.batchId }); await newGate.hit.promise;
    const pendingBefore = await f.a2.chat.pending(null); assert.equal(pendingBefore.input.operationId, fresh.rooms[0].input.operationId);
    oldGate.release.resolve(); await oldSend;
    assert.deepEqual(await f.a2.chat.pending(null), pendingBefore);
    assert.equal((await f.clientB.pendingRooms()).batchId, fresh.batchId);
    newGate.release.resolve(); assert.equal((await newSend).rooms[0].state, 'result-unknown');
    assert.deepEqual(await f.a2.chat.pending(null), pendingBefore);
    const resolved = await f.clientB.sendRooms({ confirmed: true, batchId: fresh.batchId });
    assert.equal(resolved.rooms[0].state, 'acknowledged'); assert.equal(await f.a2.chat.pending(null), null);
    assert.deepEqual(f.creates[2].input, f.creates[3].input);
  } finally { oldGate.release.resolve(); newGate?.release.resolve(); await oldSend.catch(() => {}); if (newSend) await newSend.catch(() => {}); }
}));

test('two independently confirmed create calls atomically claim one original journal and reject the other before HTTP', { timeout: 90000 }, () => fixtureRun(async f => {
  const first = { hit: deferred(), release: deferred() }, second = { hit: deferred(), release: deferred() };
  f.ownerStore.setGate({ key: f.localKey.replace('task-room-batch:' + f.taskId, 'chat-operation:create'), tickets: [first, second] });
  const original = { roomId: crypto.randomUUID(), operationId: crypto.randomUUID(), title: 'Original explicitly confirmed room' };
  const other = { roomId: crypto.randomUUID(), operationId: crypto.randomUUID(), title: 'Independent second confirmation' };
  const gate = { kind: 'create', hit: deferred(), release: deferred(), lose: true }; f.setResponseGate(gate);
  const p1 = f.a.chat.create(original, { confirmed: true }); const unknown = assert.rejects(p1, /lost exact original Room ACK/);
  await first.hit.promise;
  const p2 = f.a2.chat.create(other, { confirmed: true }); const rejected = assert.rejects(p2, /上一次操作/);
  await second.hit.promise; first.release.resolve(); await gate.hit.promise;
  second.release.resolve(); await rejected; f.ownerStore.setGate(null);
  gate.release.resolve(); await unknown;
  const pending = await f.a2.chat.pending(null); assert.equal(pending.input.operationId, original.operationId);
  assert.equal(f.creates.length, 1); assert.equal(f.creates[0].input.roomId, original.roomId);
  await f.a2.chat.retry(null, { confirmed: true }); assert.equal(await f.a2.chat.pending(null), null);
  assert.deepEqual(f.creates[0].input, f.creates[1].input);
  const unavailable = createTaskContactClient({ ...f.a, updateLocal: undefined }, f.taskId);
  await assert.rejects(unavailable.prepareRooms('separate', [f.bid]), /local_atomic_update_unavailable/);
}));
