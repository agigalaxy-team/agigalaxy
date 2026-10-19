import test from 'node:test';
import { retainTaskContactAgent, taskContactWebsite } from './task-contact-agent-fixture.mjs';
import assert from 'node:assert/strict';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { oidcProviderFixture } from '../../galaxy-official/test/oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../../galaxy-official/src/oidc-login.mjs';
import { createApi } from '../../galaxy-official/src/http.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { createExistingWebRuntime, confirmFixtureAccountLink } from '../../galaxy-official/test/existing-web-identity-fixture.mjs';
import { taskDraft, publicationFromDraft } from '../src/task-bounty-client.mjs';
import { createTaskContactClient } from '../src/task-contact-client.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Explicit single-process synchronous clone transaction. Real IDB mutual
// exclusion is covered separately; this fixture only controls actual read order.
function memoryStore() {
  const values = new Map(); let readGate = null;
  return {
    setGate(value) { readGate = value; },
    async get(key) {
      const value = structuredClone(values.get(key));
      if (readGate?.key === key && readGate.tickets.length) {
        const ticket = readGate.tickets.shift(); ticket.hit.resolve(value); await ticket.release.promise;
      }
      return value;
    },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async update(key, updater) {
      const next = updater(structuredClone(values.get(key)));
      if (next && typeof next.then === 'function') throw Error('synchronous_update_required');
      const stored = structuredClone(next); values.set(key, stored); return structuredClone(stored);
    },
  };
}
async function fixtureRun(run) {
  const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  const runtimes = []; let f, server, responseGate = null;
  const writes = [], consents = [], receipts = [];
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic M11 shared batch OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
    f = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
    server = createApi({ ...f, rateLimit: 3000 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const wire = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/consents') consents.push(JSON.parse(init.body));
      if (path === '/v2/tasks/receipt') receipts.push(JSON.parse(init.body));
      const response = await fetch(origin + path, init);
      if (/^\/v2\/tasks\/.+\/events$/.test(path)) {
        const submission = JSON.parse(init.body), payload = JSON.parse(submission.payloadJson);
        writes.push({ ...payload.event, status: response.status, submission });
        if (responseGate && payload.event.kind === 'invite') {
          const selected = responseGate; responseGate = null;
          assert.equal(response.status, 200); selected.hit.resolve(); await selected.release.promise;
          if (selected.lose) throw Error('lost original invite ACK');
        }
      }
      return response;
    };
    const ownerStore = memoryStore(), config = { endpoint, trustedKeys: f.bindings.trustedKeys };
    const stores = new WeakMap();
    const make = async store => { const rt = await createExistingWebRuntime(config, { store, fetch: wire, now: () => now, website: taskContactWebsite }); stores.set(rt, store); runtimes.push(rt); return rt; };
    const a = await make(ownerStore), b = await make(memoryStore()), c = await make(memoryStore());
    for (const rt of [a, b, c]) { await rt.connect({ confirmed: true }); await retainTaskContactAgent(rt, stores.get(rt), now); }
    issuer.setAccount('synthetic-m11-owner');
    const login = await a.api.call('/v1/identity/begin', { providerId: 'fixture' });
    const callback = await issuer.authorize(login.authorizationUrl);
    assert.equal((await fetch(origin + callback.pathname + callback.search)).status, 200);
    await confirmFixtureAccountLink(a, login.loginId);
    const a2 = await make(ownerStore); await a2.connect({ confirmed: true });
    assert.equal(a.api.snapshot().subjectId, a2.api.snapshot().subjectId);
    assert.notEqual(a.api.snapshot().bindingId, a2.api.snapshot().bindingId);
    const { taskId } = await a.publishTask(publicationFromDraft(taskDraft({ title: 'M11 original reviewed batch',
      summary: 'Synthetic isolated fixture', goal: 'Exact recipient confirmation', situation: 'Shared local storage',
      visibility: 'Public', intent: 'diagnosis' }, now), [], now), { confirmed: true });
    const clientA = createTaskContactClient(a, taskId), clientB = createTaskContactClient(a2, taskId);
    const read = () => a.api.call(`/v2/tasks/${taskId}`, null, { method: 'GET' });
    await run({ a, a2, b, c, taskId, clientA, clientB, ownerStore, writes, consents, receipts, read,
      localKey: `galaxy-web:${endpoint}:${a.api.snapshot().subjectId}:task-contact-batch:${taskId}`,
      setResponseGate: value => { responseGate = value; } });
    const current = await read(); assert.equal(current.caseId, null); assert.equal(current.participations.length, 0);
  } finally {
    if (responseGate) responseGate.release.resolve();
    for (const runtime of runtimes) runtime.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (f) await f.db.close();
    await issuer.close();
  }
}

test('atomic preparation keeps the reviewed recipient and rejects missing/stale displayed batch IDs before Consent or invite', { timeout: 90000 }, () => fixtureRun(async f => {
  const first = { hit: deferred(), release: deferred() }, second = { hit: deferred(), release: deferred() };
  f.ownerStore.setGate({ key: f.localKey, tickets: [first, second] });
  const p1 = f.clientA.prepareInvites([{ subjectId: f.b.api.snapshot().subjectId, note: 'reviewed A to B' }]);
  assert.equal(await first.hit.promise, undefined);
  const p2 = f.clientB.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'independent B to C' }]);
  const rejected = assert.rejects(p2, /原联系批次/);
  assert.equal(await second.hit.promise, undefined);
  first.release.resolve(); const batch = await p1;
  second.release.resolve(); await rejected; f.ownerStore.setGate(null);
  assert.equal((await f.clientB.pending()).batchId, batch.batchId);
  const before = f.consents.length;
  await assert.rejects(f.clientA.sendInvites({ confirmed: true }), error => error.code === 'task_contact_batch_id_required');
  await assert.rejects(f.clientA.sendInvites({ confirmed: true, batchId: crypto.randomUUID() }), error => error.code === 'task_contact_batch_changed');
  assert.equal(f.consents.length, before); assert.equal(f.writes.length, 0);
  const sent = await f.clientA.sendInvites({ confirmed: true, batchId: batch.batchId });
  assert.equal(sent.items[0].state, 'acknowledged'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].eventId, batch.items[0].eventId); assert.equal(f.writes[0].recipientId, f.b.api.snapshot().subjectId);
  assert.equal(f.writes[0].note, batch.items[0].note);
}));

test('late exact ACK cannot overwrite a replacement batch or turn an acknowledged item back into unknown', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareInvites([{ subjectId: f.b.api.snapshot().subjectId, note: 'original reviewed text' }]);
  const gate = { hit: deferred(), release: deferred(), lose: false }; f.setResponseGate(gate);
  const firstSend = f.clientA.sendInvites({ confirmed: true, batchId: original.batchId });
  try {
    await gate.hit.promise;
    const reconciled = await f.clientB.sendInvites({ confirmed: true, batchId: original.batchId });
    assert.equal(reconciled.items[0].state, 'acknowledged');
    const next = await f.clientB.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'new reviewed text must survive' }]);
    gate.release.resolve(); const late = await firstSend;
    assert.equal(late.items[0].state, 'acknowledged');
    const retained = await f.clientB.pending();
    assert.equal(retained.batchId, next.batchId); assert.equal(retained.items[0].eventId, next.items[0].eventId);
    assert.equal(retained.items[0].state, 'queued'); assert.equal(retained.items[0].note, next.items[0].note);
    assert.equal(f.writes.length, 1); assert.ok(f.receipts.some(item => item.eventId === original.items[0].eventId));
    const sent = await f.clientB.sendInvites({ confirmed: true, batchId: next.batchId });
    assert.equal(sent.items[0].state, 'acknowledged'); assert.equal(f.writes.length, 2);
  } finally { gate.release.resolve(); }
}));

test('lost ACK is checked by the original event/hash without new Consent, while late unknown cannot downgrade shared ACK', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareInvites([{ subjectId: f.b.api.snapshot().subjectId, note: 'exact unknown ACK intent' }]);
  const gate = { hit: deferred(), release: deferred(), lose: true }; f.setResponseGate(gate);
  const firstSend = f.clientA.sendInvites({ confirmed: true, batchId: original.batchId });
  try {
    await gate.hit.promise; const before = f.consents.length;
    const ack = await f.clientB.sendInvites({ confirmed: true, batchId: original.batchId });
    assert.equal(ack.items[0].state, 'acknowledged'); assert.equal(f.consents.length, before);
    gate.release.resolve(); const late = await firstSend;
    assert.equal(late.items[0].state, 'acknowledged'); assert.equal((await f.clientB.pending()).items[0].state, 'acknowledged');
    assert.equal(f.writes.length, 1);
    const reentry = createTaskContactClient(f.a2, f.taskId), retained = await reentry.pending();
    const checked = await reentry.sendInvites({ confirmed: true, batchId: retained.batchId });
    assert.equal(checked.items[0].eventId, original.items[0].eventId);
    assert.equal(checked.items[0].payloadHash, ack.items[0].payloadHash); assert.equal(f.consents.length, before); assert.equal(f.writes.length, 1);
  } finally { gate.release.resolve(); }
}));

test('unsent cancellation, changed connection and missing atomic storage cannot create an invitation', { timeout: 90000 }, () => fixtureRun(async f => {
  const original = await f.clientA.prepareInvites([{ subjectId: f.b.api.snapshot().subjectId, note: 'never externalize this cancelled text' }]);
  const before = f.consents.length;
  const stopped = await f.clientA.stopUnsent(original.items[0].eventId);
  assert.equal(stopped.items[0].state, 'stopped-unsent'); assert.equal(f.consents.length, before); assert.equal(f.writes.length, 0);
  const current = await f.clientA.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'retained on original owner' }]);
  await f.a.connect({ confirmed: true });
  await assert.rejects(f.clientA.sendInvites({ confirmed: true, batchId: current.batchId }), /身份或连接已改变/);
  assert.equal(f.writes.length, 0); assert.equal(f.consents.length, before);
  const fresh = createTaskContactClient(f.a, f.taskId);
  assert.equal((await fresh.pending()).batchId, current.batchId);
  const noAtomic = createTaskContactClient({ ...f.a, updateLocal: undefined }, f.taskId);
  await assert.rejects(noAtomic.sendInvites({ confirmed: true, batchId: current.batchId }), /local_atomic_update_unavailable/);
  assert.equal(f.writes.length, 0); assert.equal(f.consents.length, before);
}));

test('exact stopped operation metadata releases its original claim while other hash and replacement remain protected', { timeout: 90000 }, () => fixtureRun(async f => {
  const reader = createTaskContactClient(f.b, f.taskId);
  await assert.rejects(reader.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'reader is not the requester' }]), error => error.code === 'task_contact_requester_required');
  assert.equal(await f.b.getLocal(`task-contact-batch:${f.taskId}`), undefined);
  const original = await f.clientA.prepareInvites([{ subjectId: f.b.api.snapshot().subjectId, note: 'original local-stop intent' }]);
  // Allow the client's first pending read, then pause the real runtime queue
  // read after it has fixed its event bytes and expected Task version.
  const first = { hit: deferred(), release: deferred() }, second = { hit: deferred(), release: deferred() };
  first.release.resolve();
  f.ownerStore.setGate({ key: f.localKey.replace('task-contact-batch:', 'task-event:'), tickets: [first, second] });
  const sending = f.clientA.sendInvites({ confirmed: true, batchId: original.batchId });
  try {
    await second.hit.promise;
    const current = await f.read(), eventId = crypto.randomUUID();
    const payload = { taskId: f.taskId, event: { eventId, kind: 'suggest-contacts', expectedTaskVersion: current.version, state: 'empty', items: [] } };
    const grant = await f.a2.api.submitAuthorization(await f.a2.api.prepareAuthorization(payload, {
      action: 'assistance.publish', objectId: eventId, visibility: 'Private', viewers: [current.requesterId], confirmed: true,
    }), { confirmed: true });
    await f.a2.api.call(`/v2/tasks/${f.taskId}/events`, grant);
    second.release.resolve(); const unknown = await sending;
    assert.equal(unknown.items[0].state, 'result-unknown'); assert.equal(unknown.items[0].error, 'task_version_conflict');
    assert.equal(f.writes.find(item => item.kind === 'invite').status, 409);
    await assert.rejects(f.clientB.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'not allowed before explicit stop' }]), /原联系批次/);
    const preview = await f.a.reviewTaskStop(f.taskId);
    assert.equal(preview.receipt.state, 'absent');
    const stopped = await f.a.stopTaskOperation(preview, { taskId: f.taskId, confirmed: true });
    assert.equal(stopped.state, 'stopped-local'); assert.equal(stopped.serverCancellationConfirmed, false);
    const archive = await f.a.stoppedTaskOperations(f.taskId);
    assert.equal(archive[0].eventId, unknown.items[0].eventId); assert.equal(archive[0].payloadHash, unknown.items[0].payloadHash);
    assert.equal(archive[0].payloadJson, undefined); assert.equal(archive[0].preparedConsent, undefined);
    assert.equal((await f.clientB.pending()).items[0].state, 'stopped-local');
    assert.equal((await f.a.getLocal(`task-contact-batch:${f.taskId}`)).items[0].state, 'result-unknown');
    // Explicit corrupt/stale local metadata negative control: an unmatched
    // digest is not evidence that this original operation was stopped.
    await f.a.putLocal(`task-stopped-operations:${f.taskId}`, archive.map(item => ({ ...item, payloadHash: 'f'.repeat(64) })));
    await assert.rejects(f.clientB.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'other digest must not release original' }]), /原联系批次/);
    await f.a.putLocal(`task-stopped-operations:${f.taskId}`, archive);
    const waiting = { hit: deferred(), release: deferred() };
    f.ownerStore.setGate({ key: f.localKey, tickets: [waiting] });
    const stalePrepare = f.clientB.prepareInvites([{ subjectId: f.b.api.snapshot().subjectId, note: 'old read cannot replace later batch' }]);
    const rejected = assert.rejects(stalePrepare, /原联系批次/);
    try {
      await waiting.hit.promise;
      const fresh = await f.clientA.prepareInvites([{ subjectId: f.c.api.snapshot().subjectId, note: 'new explicitly reviewed original batch' }]);
      waiting.release.resolve(); await rejected;
      assert.notEqual(fresh.batchId, original.batchId); assert.notEqual(fresh.items[0].eventId, original.items[0].eventId);
      assert.equal((await f.clientB.pending()).batchId, fresh.batchId);
      const before = f.consents.length;
      await assert.rejects(f.clientB.sendInvites({ confirmed: true, batchId: original.batchId }), error => error.code === 'task_contact_batch_changed');
      const checked = await f.a.queryStoppedTaskOperation(original.items[0].eventId, { taskId: f.taskId });
      assert.equal(checked.receipt.state, 'absent'); assert.equal(f.consents.length, before);
      const archivedAfter = (await f.a.stoppedTaskOperations(f.taskId))[0];
      assert.equal(archivedAfter.eventId, archive[0].eventId); assert.equal(archivedAfter.payloadHash, archive[0].payloadHash);
      assert.equal(archivedAfter.payloadJson, undefined);
      const sent = await f.clientA.sendInvites({ confirmed: true, batchId: fresh.batchId });
      assert.equal(sent.items[0].state, 'acknowledged');
      assert.equal(f.writes.filter(item => item.kind === 'invite').length, 2);
      assert.equal(f.writes.filter(item => item.eventId === original.items[0].eventId).length, 1);
      assert.equal((await f.read()).contacts.responses.invitations[0].invitationId, fresh.items[0].eventId);
    } finally { waiting.release.resolve(); f.ownerStore.setGate(null); await rejected; }
  } finally { second.release.resolve(); f.ownerStore.setGate(null); await sending; }
}));
