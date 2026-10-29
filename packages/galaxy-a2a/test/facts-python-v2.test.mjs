import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeA2aHostV2 } from '../src/hosts/host-flow-v2.mjs';
import { createA2aFactsV2 } from '../src/facts/facts-v2.mjs';
import { discoverA2aCard } from '../src/protocol/card-discovery.mjs';
import { hash } from '../src/storage/journal.mjs';
import { goDomainFixture } from './go-domain-fixture.mjs';
import { pythonPeer } from './python-peer.mjs';

test('official Python 1.1.2 HelloWorld → actual HTTP v2 Attempt/Result; original unknown operations survive restart',
  { skip: !process.env.GALAXY_A2A_PYTHON, timeout: 120000 }, async t => {
  const peer = await pythonPeer(process.env.GALAXY_A2A_PYTHON); t.after(() => peer.close());
  const {owner:f,origin:local}=await goDomainFixture(t);
  let loseResult = true, resultWrites = 0, current = f.actor.subjectId;
  let forbidCaseRead = false, receiptUnavailable = false, switchReceiptOwner = false;
  let generation = 1, switchReceiptGeneration = false, switchPeerGeneration = false, authorizationMutation;
  const call = async (path, input, options = {}) => {
    if (forbidCaseRead && /^\/v2\/cases\/[^/]+\/read$/.test(path)) throw new Error('Original material reread forbidden');
    if (receiptUnavailable && path === '/v2/cases/events/receipt') throw new Error('Synthetic receipt unavailable');
    const response = await fetch(local + path, { method: options.method ?? 'POST', headers: { 'Content-Type': 'application/json',
      authorization: 'Bearer ' + f.credential }, ...(options.method === 'GET' ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error ?? JSON.stringify(value)), { status: response.status });
    if (path === '/v2/cases/events' && JSON.parse(input.payloadJson).kind === 'result-recorded') {
      resultWrites++; if (loseResult) { loseResult = false; throw new Error('Lost actual committed Result ACK'); }
    }
    if (switchReceiptOwner && path === '/v2/cases/events/receipt') current = 'GUID' + 'B'.repeat(28);
    if (switchReceiptGeneration && path === '/v2/cases/events/receipt') generation++;
    return value;
  };
  const authorizations = new Map(); let consentWrites = 0;
  const runtime = { api: { endpoint: f.access.endpoint, call, snapshot: () => ({ subjectId: current, bindingId: f.actor.bindingId, generation }) },
    status: async () => ({ identity: current }),
    authorize: async input => {
      if (!authorizations.has(input.requestId)) { consentWrites++;
        authorizations.set(input.requestId, await f.authorize(JSON.parse(input.payloadJson), input.action,
          { id: input.requestId, objectId: input.objectId, visibility: input.visibility, viewers: input.viewers })); }
      if (authorizationMutation === 'subject') current = 'GUID' + 'B'.repeat(28);
      if (authorizationMutation === 'generation') generation++;
      return authorizations.get(input.requestId);
    } };
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-a2a-python-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trust = await discoverA2aCard({ cardUrl: 'https://python-peer.example.org/.well-known/agent-card.json', endpoint: peer.endpoint,
    expectedCardHash: hash(JSON.stringify(peer.card)), trustExpiresAt: Date.now() + 60000, fetchJson: peer.get });
  const options = { runtime, directory, peers: [{ id: 'python', name: 'Synthetic official Python', endpoint: peer.endpoint,
    agentCard: trust.card, cardHash: trust.cardHash, trustExpiresAt: trust.trustExpiresAt, peerPrincipal: 'synthetic-local' }],
    readPeerAuthorization: async () => {
      if (switchPeerGeneration) generation++;
      return { subjectId: current, peerPrincipal: 'synthetic-local' };
    }, post: (...args) => peer.post(...args) };
  let host = createNativeA2aHostV2(options);
  async function attempt() {
    const caseId = randomUUID(), eventId = randomUUID();
    const root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0, actorId: f.actor.subjectId,
      localRef: randomUUID(), title: 'Synthetic Python A2A', summary: 'PRIVATE whole original problem MUST NOT LEAVE',
      source: { kind: 'local', reference: randomUUID() }, synthetic: true };
    await call('/v2/cases/events', await f.authorize(root, 'case.teaser.publish', { objectId: caseId }));
    const start = { schemaVersion: 2, kind: 'attempt-start', eventId, caseId, expectedVersion: 1, actorId: f.actor.subjectId,
      role: 'caller', strategy: 'Selected external HelloWorld operation', inputScopeSummary: 'Only reviewed text', permissionScope: ['selected-text'] };
    await call('/v2/cases/events', await f.authorize(start, 'case.teaser.publish', { objectId: eventId }));
    return { caseId, attemptId: eventId, attemptVersion: 1 };
  }
  const ids = await attempt();
  const preview = await host.prepare('python', 'send', { ...ids, text: 'Selected synthetic request' });
  let link = await host.execute(preview, { confirmed: true });
  for (let i = 0; i < 10 && link.peer.state !== 'completed'; i++) link = await host.read('python', 'poll', link.id);
  assert.equal(link.peer.state, 'completed'); assert.equal(link.factContext.attemptRef.id, ids.attemptId);
  assert.equal(peer.info.protocol, '1.0'); assert.equal(peer.info.sdk, '1.1.2');
  assert.ok(link.peer.artifacts.some(a => a.parts.some(p => p.text?.includes('Hello, World!'))));
  for (const privateValue of [ids.caseId, ids.attemptId, f.actor.subjectId, 'PRIVATE whole original']) assert.ok(!JSON.stringify(peer.requests).includes(privateValue));
  const result = await host.prepare('python', 'result', { associationId: link.id, summary: 'HelloWorld answered the selected message; original issue untested', reportedOutcome: 'inconclusive' });
  assert.equal(result.draft.event.kind, 'result-recorded'); assert.deepEqual(result.draft.event.deliverableRefs, []);
  assert.equal((await host.read('python', 'reconcile-result', link.id)).state, 'absent');
  assert.equal(resultWrites, 0, 'an absent receipt read never submits a Result');
  await assert.rejects(host.execute(result, { confirmed: true }), /Lost actual committed/);
  host = createNativeA2aHostV2(options);
  const receipt = await host.read('python', 'reconcile-result', link.id);
  assert.equal(receipt.state, 'acknowledged'); assert.equal(resultWrites, 1); assert.equal(consentWrites, 1);
  const facts = await call(`/v2/cases/${ids.caseId}/read`, {});
  assert.equal(facts.results.length, 1); assert.equal(facts.results[0].verification, 'not-provided');
  assert.equal(facts.results[0].acceptance, 'not-provided'); assert.equal(facts.resolution.status, 'unrecorded');
  assert.equal(facts.attempts.at(-1).status, 'running', 'peer completed never auto-ends the user Attempt');
  await assert.rejects(host.prepare('python', 'send', { ...ids, text: 'duplicate' }), /already dispatched/);
  await f.consents.revoke(f.actor, authorizations.get(result.authorization.requestId).consentId);
  await f.db.query("UPDATE case_events SET payload='{}'::jsonb,payload_text='' WHERE id=$1", [result.draft.event.eventId]);
  forbidCaseRead = true;
  const withdrawn = await host.read('python', 'reconcile-result', link.id);
  assert.equal(withdrawn.state, 'acknowledged'); assert.equal(withdrawn.authority, 'accepted-operation-only');
  assert.equal(withdrawn.currentAccessGranted, false); assert.equal(resultWrites, 1);
  assert.equal(JSON.stringify(withdrawn).includes(result.draft.event.summary), false);
  assert.equal(Object.hasOwn(withdrawn, 'externalSource'), false);
  receiptUnavailable = true;
  await assert.rejects(host.read('python', 'reconcile-result', link.id), /receipt unavailable/);
  assert.equal(resultWrites, 1, 'an unavailable receipt cannot create or resend work');
  receiptUnavailable = false; switchReceiptOwner = true;
  await assert.rejects(host.read('python', 'reconcile-result', link.id), /connection changed/);
  current = f.actor.subjectId; switchReceiptOwner = false; forbidCaseRead = false;
  switchReceiptGeneration = true;
  await assert.rejects(host.read('python', 'reconcile-result', link.id), /connection changed/);
  switchReceiptGeneration = false; switchPeerGeneration = true;
  const beforePeerLease = peer.requests.length;
  await assert.rejects(host.read('python', 'get', link.id), /connection changed/);
  assert.equal(peer.requests.length, beforePeerLease); switchPeerGeneration = false;
  assert.equal((await host.read('python', 'reconcile-result', link.id)).state, 'acknowledged', 'fresh binding rebuilds validator and keeps original journal');
  const authorizing = await attempt();
  let authorizationLink = await host.execute(await host.prepare('python', 'send', { ...authorizing, text: 'Selected lease counterexample' }), { confirmed: true });
  for (let i = 0; i < 10 && authorizationLink.peer.state !== 'completed'; i++) authorizationLink = await host.read('python', 'poll', authorizationLink.id);
  const authorizationInput = { associationId: authorizationLink.id, summary: 'Old scope must not dispatch after authorization waits', reportedOutcome: 'inconclusive' };
  authorizationMutation = 'subject'; const beforeAuthorization = resultWrites;
  await assert.rejects(host.execute(await host.prepare('python', 'result', authorizationInput), { confirmed: true }), /connection changed/);
  assert.equal(resultWrites, beforeAuthorization, 'changed subject after authorize makes zero business writes');
  current = f.actor.subjectId; authorizationMutation = 'generation';
  await assert.rejects(host.execute(await host.prepare('python', 'result', authorizationInput), { confirmed: true }), /connection changed/);
  assert.equal(resultWrites, beforeAuthorization, 'same subject/binding with a new generation makes zero business writes');
  authorizationMutation = undefined;
  const unknown = await attempt(), lost = createNativeA2aHostV2({ ...options, post: async (...args) => { await peer.post(...args); throw new Error('lost peer ACK'); } });
  const sending = await lost.prepare('python', 'send', { ...unknown, text: 'unknown synthetic' }), before = peer.requests.length;
  await assert.rejects(lost.execute(sending, { confirmed: true }), e => e.code === 'A2A_OUTCOME_UNKNOWN');
  const restarted = createNativeA2aHostV2(options);
  await assert.rejects(restarted.prepare('python', 'send', { ...unknown, text: 'must not resend' }), /already dispatched/);
  await assert.rejects(restarted.read('python', 'poll', sending.associationId), /No observed/); assert.equal(peer.requests.length, before + 1);
  const stale = await attempt(); const p = await host.prepare('python', 'send', { ...stale, text: 'stale' });
  const end = { schemaVersion: 2, kind: 'attempt-end', eventId: randomUUID(), caseId: stale.caseId, expectedVersion: 2, actorId: f.actor.subjectId,
    attemptRef: { id: stale.attemptId, version: 1 }, status: 'canceled', summary: 'canceled locally', failureReason: 'user stopped' };
  await call('/v2/cases/events', await f.authorize(end, 'case.teaser.publish', { objectId: end.eventId }));
  const calls = peer.requests.length; await assert.rejects(host.execute(p, { confirmed: true }), /Attempt version/); assert.equal(peer.requests.length, calls);
  const provenance = JSON.parse(await readFile(new URL('./python/provenance.json', import.meta.url)));
  assert.equal(hash(await readFile(new URL('./python/vendor/agent_executor.py', import.meta.url))), provenance.sources[0].sha256);
  // Independently authored lifecycle executor using the same official Python
  // SDK. These states are not attributed to the upstream HelloWorld sample.
  const lifecycle = createNativeA2aHostV2({ ...options, peers: [{ ...options.peers[0], id: 'lifecycle',
    endpoint: 'https://python-peer.example.org/lifecycle', agentCard: peer.lifecycleCard, cardHash: hash(JSON.stringify(peer.lifecycleCard)) }] });
  for (const command of ['input', 'auth', 'work', 'fail', 'reject']) {
    const context = await attempt();
    let observed = await lifecycle.execute(await lifecycle.prepare('lifecycle', 'send', { ...context, text: command }), { confirmed: true });
    for (let i = 0; i < 10 && observed.peer.state === 'submitted'; i++) observed = await lifecycle.read('lifecycle', 'poll', observed.id);
    if (['input', 'auth'].includes(command)) {
      assert.equal(observed.peer.state, command + '-required');
      const resumed = await lifecycle.execute(await lifecycle.prepare('lifecycle', 'reply', { associationId: observed.id, text: 'complete' }), { confirmed: true });
      let done = resumed; for (let i = 0; i < 10 && done.peer.state !== 'completed'; i++) done = await lifecycle.read('lifecycle', 'poll', done.id);
      assert.equal(done.peer.state, 'completed'); assert.equal(done.peer.taskId, observed.peer.taskId); assert.equal(done.peer.contextId, observed.peer.contextId);
    } else if (command === 'work') {
      assert.equal(observed.peer.state, 'working');
      const canceled = await lifecycle.execute(await lifecycle.prepare('lifecycle', 'cancel', { associationId: observed.id }), { confirmed: true });
      assert.equal(canceled.peer.state, 'canceled');
    } else assert.equal(observed.peer.state, command === 'fail' ? 'failed' : 'rejected');
  }
});

test('v2 exact participants and Card trust refuse scope drift, implicit actors, alternate endpoint and protocol 0.3', async () => {
  const subjectId = 'GUID' + 'A'.repeat(28), caseId = randomUUID(), attemptId = randomUUID(), taskId = randomUUID(), participationId = randomUUID();
  const a = { id: attemptId, version: 1, actorId: subjectId, provenance: 'native-v2', scopeVersion: 1, taskId, participationId, participationScopeVersion: 2 };
  const view = { caseId, version: 2, scopeVersion: 1, attempts: [a] };
  const task = { taskId, caseId, state: 'open', participations: [{ participationId, subjectId, scopeVersion: 2, state: 'active' }] };
  const reader = createA2aFactsV2({ readCase: async () => view, readTask: async () => task });
  const args = { subjectId, caseId, attemptId, selected: { attemptVersion: 1, taskId } };
  const first = await reader.resolve(args); task.participations[0].scopeVersion = 3;
  await assert.rejects(reader.resolve({ ...args, frozen: first.factContext }), /Participation unavailable/);
  task.participations[0].scopeVersion = 2; task.participations[0].subjectId = 'GUID' + 'B'.repeat(28);
  await assert.rejects(reader.resolve(args), /Participation unavailable/);
  const card = { supportedInterfaces: [{ url: 'https://peer.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.3' }] };
  await assert.rejects(discoverA2aCard({ cardUrl: 'https://peer.example/card', endpoint: 'https://peer.example/a2a', expectedCardHash: hash(JSON.stringify(card)), trustExpiresAt: Date.now() + 1000, fetchJson: async () => card }), /1.0/);
  let fetched = 0;
  await assert.rejects(discoverA2aCard({ cardUrl: 'https://evil.example/card', endpoint: 'https://peer.example/a2a', expectedCardHash: hash(JSON.stringify(card)), trustExpiresAt: Date.now() + 1000, fetchJson: async () => { fetched++; } }), /trust/);
  assert.equal(fetched, 0);
});
