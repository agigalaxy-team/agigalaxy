import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createA2aBridge } from '../src/bridge.mjs';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { sdkPeer } from './sdk-peer.mjs';

test('A2A SDK 1.1.0 HTTP interoperability linked to real Galaxy Cases', { timeout: 120000 }, async t => {
  const f = await serviceFixture();
  t.after(() => f.db.close());
  const peer = await sdkPeer();
  t.after(() => peer.close());
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-a2a-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let currentSubject = f.actor.subjectId;
  const options = { endpoint: peer.endpoint, tenant: 'fixture', agentCard: peer.card, directory,
    subjectId: f.actor.subjectId, peerPrincipal: 'external-fixture-user', officialEndpoint: 'https://official.example.org',
    authorize: async () => ({ subjectId: currentSubject, peerPrincipal: 'external-fixture-user', credential: 'synthetic-external-token' }),
    cases: { get: id => f.cases.get(f.actor, id) }, post: (...args) => peer.post(...args) };
  const bridge = createA2aBridge(options);
  async function attempt() {
    const caseId = randomUUID(); const attemptId = randomUUID();
    const root = { kind: 'case', id: caseId, localRef: randomUUID(), title: 'A2A fixture', summary: 'Private Case source, never automatically disclosed.',
      source: { kind: 'local', reference: caseId }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await f.cases.submit(f.actor, await f.authorize(root));
    await f.cases.submit(f.actor, await f.authorize({ kind: 'attempt', id: attemptId, caseId, expectedVersion: 1, sequence: 1,
      approach: 'Run selected request via external A2A', configuration: { environment: 'fixture', version: '1.0', tools: ['A2A'] } }));
    return { caseId, attemptId };
  }
  async function send(text, adapter = bridge) {
    const ids = await attempt();
    const preview = await adapter.prepareStart({ ...ids, text });
    return adapter.execute(preview, preview.confirmation);
  }
  await t.test('completed task keeps IDs, maps artifacts and submits only a separately consented Case Result', async () => {
    const ids = await attempt();
    const preview = await bridge.prepareStart({ ...ids, text: 'complete' });
    const before = peer.requests.length;
    await assert.rejects(bridge.execute(preview, 'yes'), /Exact A2A/);
    assert.equal(peer.requests.length, before);
    const link = await bridge.execute(preview, preview.confirmation);
    assert.equal(link.peer.state, 'completed');
    assert.notEqual(link.peer.taskId, ids.attemptId);
    assert.notEqual(link.peer.contextId, ids.caseId);
    assert.equal(link.caseId, ids.caseId);
    const wire = JSON.stringify(peer.requests.at(-1).body);
    for (const privateText of [ids.caseId, ids.attemptId, f.actor.subjectId, 'Private Case source']) assert.ok(!wire.includes(privateText));
    assert.equal(peer.requests.at(-1).version, '1.0');
    assert.equal(peer.requests.at(-1).authorization, 'Bearer synthetic-external-token');
    assert.equal(link.peer.artifacts[0].parts[0].kind, 'text');
    assert.match(link.peer.artifacts[0].parts[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(link.peer.artifacts[0].parts[1].downloaded, false);
    assert.ok(!JSON.stringify(link).includes('signed-url'));
    const draft = await bridge.prepareResult(link.id);
    assert.equal((await f.cases.get(f.actor, ids.caseId)).version, 2);
    assert.equal(draft.event.attemptId, ids.attemptId);
    assert.equal(draft.event.outcome, 'succeeded');
    const stored = await f.cases.submit(f.actor, await f.authorize(draft.event));
    assert.equal(stored.version, 3); assert.equal(stored.verification, 'unverified');
    const restarted = createA2aBridge(options);
    assert.equal((await restarted.get(link.id)).peer.taskId, link.peer.taskId);
    await assert.rejects(restarted.prepareStart({ ...ids, text: 'complete' }), /already dispatched/);
    await assert.rejects(bridge.execute(preview, preview.confirmation), /Exact A2A/);
  });
  await t.test('input-required and auth-required resume the same Task/Context after fresh host confirmation', async () => {
    for (const command of ['input', 'auth']) {
      const link = await send(command);
      assert.equal(link.peer.state, `${command}-required`);
      await assert.rejects(bridge.prepareResult(link.id), /terminal/);
      const reply = await bridge.prepareReply(link.id, 'complete');
      const completed = await bridge.execute(reply, reply.confirmation);
      assert.equal(completed.peer.state, 'completed');
      assert.equal(completed.peer.taskId, link.peer.taskId);
      assert.equal(completed.peer.contextId, link.peer.contextId);
    }
  });
  await t.test('explicit cancel confirms remote terminal state; canceled maps to inconclusive', async () => {
    const link = await send('work');
    assert.equal((await bridge.poll(link.id)).peer.state, 'working');
    const cancel = await bridge.prepareCancel(link.id);
    const result = await bridge.execute(cancel, cancel.confirmation);
    assert.equal(result.peer.state, 'canceled');
    assert.equal((await bridge.prepareResult(link.id)).event.outcome, 'inconclusive');
  });
  await t.test('standalone messages never become a successful Task or Case Result', async () => {
    const link = await send('message');
    assert.equal(link.peer.state, 'message-only');
    await assert.rejects(bridge.prepareResult(link.id), /terminal/);
    await assert.rejects(bridge.poll(link.id), /No observed peer task ID/);
  });
  await t.test('failed and rejected tasks retain failure reason and external-report limitation', async () => {
    for (const command of ['fail', 'reject']) {
      const link = await send(command);
      const draft = await bridge.prepareResult(link.id);
      assert.equal(draft.event.outcome, 'failed');
      assert.ok(draft.event.failureReason);
      assert.match(draft.event.limitations[0], /no independent/);
    }
  });
  await t.test('protocol errors preserve known association and reconcile through polling', async () => {
    const link = await send('work');
    peer.setUser('different-peer-user');
    await assert.rejects(bridge.poll(link.id), error => error.code === 'TASK_NOT_FOUND');
    assert.equal((await bridge.get(link.id)).status, 'peer-error');
    peer.setUser('external-fixture-user');
    assert.equal((await bridge.poll(link.id)).peer.state, 'working');
    const cancel = await bridge.prepareCancel(link.id);
    await peer.complete(link.peer.taskId);
    await assert.rejects(bridge.execute(cancel, cancel.confirmation), error => error.code === 'TASK_NOT_CANCELABLE');
    assert.equal((await bridge.poll(link.id)).peer.state, 'completed');
  });
  await t.test('lost initial acknowledgement persists unknown across restart and cannot be resent', async () => {
    const ids = await attempt();
    const dropping = createA2aBridge({ ...options, post: async (...args) => { await peer.post(...args); throw new Error('lost response'); } });
    const preview = await dropping.prepareStart({ ...ids, text: 'complete' });
    const before = peer.requests.length;
    await assert.rejects(dropping.execute(preview, preview.confirmation), error => error.code === 'A2A_OUTCOME_UNKNOWN');
    assert.equal(peer.requests.length, before + 1);
    const restarted = createA2aBridge(options);
    const link = await restarted.get(preview.associationId);
    assert.equal(link.status, 'unknown');
    await assert.rejects(restarted.prepareStart({ ...ids, text: 'complete' }), /already dispatched/);
    await assert.rejects(restarted.poll(link.id), /No observed/);
  });
  await t.test('local abort of a dispatched cancel does not report remote canceled', async () => {
    const link = await send('work');
    let entered;
    const atTransport = new Promise(resolve => { entered = resolve; });
    const hanging = createA2aBridge({ ...options, post: async (_url, { signal }) => {
      entered();
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    } });
    const cancel = await hanging.prepareCancel(link.id);
    const running = hanging.execute(cancel, cancel.confirmation);
    const rejected = assert.rejects(running, error => error.code === 'A2A_OUTCOME_UNKNOWN');
    await atTransport;
    hanging.abort(cancel);
    await rejected;
    assert.equal((await hanging.get(link.id)).status, 'unknown');
    assert.equal((await bridge.poll(link.id)).peer.state, 'working');
  });
  await t.test('competing prepared sends use one durable Attempt reservation', async () => {
    const ids = await attempt();
    const other = createA2aBridge(options);
    const one = await bridge.prepareStart({ ...ids, text: 'complete' });
    const two = await other.prepareStart({ ...ids, text: 'complete' });
    const before = peer.requests.length;
    const results = await Promise.allSettled([bridge.execute(one, one.confirmation), other.execute(two, two.confirmation)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(peer.requests.length, before + 1);
  });
  await t.test('scope, current actor, Case ownership and wire version are enforced before sending', async () => {
    const link = await send('work');
    await assert.rejects(createA2aBridge({ ...options, peerPrincipal: 'other' }).get(link.id), /not found/);
    const reply = await bridge.prepareCancel(link.id);
    currentSubject = 'GUID' + 'A'.repeat(28);
    const before = peer.requests.length;
    await assert.rejects(bridge.execute(reply, reply.confirmation), /authorization changed/);
    currentSubject = f.actor.subjectId;
    await assert.rejects(bridge.prepareStart({ caseId: randomUUID(), attemptId: randomUUID(), text: 'complete' }));
    assert.equal(peer.requests.length, before);
    assert.throws(() => createA2aBridge({ ...options, agentCard: { ...peer.card, supportedInterfaces: [{ ...peer.card.supportedInterfaces[0], protocolVersion: '0.3' }] } }), /1.0 JSONRPC/);
    const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
    for (const file of files) {
      const content = await readFile(join(directory, file), 'utf8');
      assert.ok(!content.includes('synthetic-external-token')); assert.ok(!content.includes(f.credential));
    }
  });
});
