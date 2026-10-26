import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createHelpRuntimeV2 } from "../src/clients/flows/help-runtime-v2.mjs";

const id = () => randomUUID();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function harness(run) {
  const scopes = ['binding', 'consent', 'assistance', 'context', 'case-teaser', 'history'], now = Math.floor(Date.now() / 1000);
  const f = await serviceFixture(scopes, null, { now }), p = await serviceFixture(scopes, f.db, { migrateDatabase: false, now });
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-help-return-')), memories = [], hosts = new Map(), requests = [];
  const api = createApi({ ...f, rateLimit: 1000 }); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, endpoint = f.access.endpoint;
  const faults = { losePath: null, failReceipt: false, hold: null, beforeSend: null };
  try {
    for (const [index, who] of [f, p].entries()) {
      const folder = join(directory, String(index)); await mkdir(folder); await writeFile(join(folder, 'galaxy-id.json'), JSON.stringify(who.genesis));
      const sessions = createSessionMemory({ now: () => now, isCurrent: async () => true }); memories.push(sessions);
      const connect = () => sessions.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes,
        expiresAt: now + 500, bindingExpiresAt: now + 900, takeCredential: () => who.credential });
      connect();
      const send = async (url, options, method = 'POST') => {
        const path = new URL(url).pathname;
        requests.push({ path, method, ...(options.bodyJson ? { body: JSON.parse(options.bodyJson) } : {}) });
        if (path === '/v2/tasks/receipt' && faults.failReceipt) throw new Error('Synthetic receipt transport unavailable');
        if (faults.beforeSend?.path === path) { const hold = faults.beforeSend; faults.beforeSend = null; hold.entered.resolve(); await hold.release.promise; }
        const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${options.credential}` },
          ...(method === 'POST' ? { body: options.bodyJson } : {}), signal: options.signal });
        const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error });
        if (faults.hold?.path === path) { const hold = faults.hold; faults.hold = null; hold.entered.resolve(); await hold.release.promise; }
        if (faults.losePath === path) { faults.losePath = null; throw new Error('Synthetic lost ACK after actual server commit'); }
        return result;
      };
      const authorizations = new Map();
      const authorize = async input => {
        if (!authorizations.has(input.requestId)) authorizations.set(input.requestId, await who.authorize(JSON.parse(input.payloadJson), input.action,
          { objectId: input.objectId, visibility: input.visibility, viewers: input.viewers, expiresAt: input.expiresAt,
            purpose: input.visibility === 'Public' ? 'public-profile' : 'operational' }));
        return authorizations.get(input.requestId);
      };
      const flow = createHelpRuntimeV2({ dataDirectory: folder, endpoint, subjectId: who.actor.subjectId, sessions, send,
        read: (url, options) => send(url, options, 'GET'), authorize, now: () => now });
      hosts.set(who, { flow, connect });
    }
    await run({ f, p, hosts, requests, faults, now });
  } finally {
    for (const memory of memories) memory.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await f.db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
}

const taskDraft = now => ({ operationId: id(), taskId: id(), caseId: null, intent: 'proactive-review', title: 'Synthetic bounded review',
  summary: 'Only the selected review scope', workContext: { goal: 'Review parser boundary', currentSituation: 'No failure claimed', attemptRefs: [] },
  visibility: 'Public', collaboration: 'open-assistance', enrollmentExpiresAt: now + 3600 });
const prepare = (flow, session, kind, payload, extra = {}) => flow.prepareAction(session.id, { kind, payloadJson: JSON.stringify(payload), ...extra });
const execute = (flow, session, preview) => flow.executeAction(session.id, { operationId: preview.operationId, payloadHash: preview.payloadHash });
const returnToWork = async (flow, session) => flow.returnToTask(session.id, { expectedRevision: (await flow.get(session.id)).revision });

test('return queries original publication receipt before reading the same Task for both signed publish routes', { timeout: 90000 }, async () => harness(async ({ f, hosts, requests, faults, now }) => {
  const { flow } = hosts.get(f);
  for (const mode of ['signed', 'prepared']) {
    const session = await flow.start({ localTaskRef: `original-chat:${mode}` }), task = taskDraft(now);
    faults.losePath = '/v2/tasks';
    if (mode === 'signed') {
      const signed = await f.authorize(task, 'assistance.publish', { objectId: task.operationId, visibility: 'Public', purpose: 'public-profile' });
      assert.equal((await flow.publish(session.id, signed)).publication.state, 'unknown');
    } else assert.equal((await execute(flow, session, await prepare(flow, session, 'publish-task', task))).state, 'unknown');
    assert.equal((await flow.get(session.id)).taskId, null);
    const beforeReturn = requests.length, returned = await returnToWork(flow, session), duringReturn = requests.slice(beforeReturn);
    assert.equal(returned.state, 'refreshed'); assert.equal(returned.remote.taskId, task.taskId);
    assert.equal(returned.handoff.localTaskRef, session.localTaskRef); assert.equal(returned.handoff.taskId, task.taskId);
    assert.deepEqual(duringReturn.map(row => row.path), ['/v2/tasks/receipt', `/v2/tasks/${task.taskId}`]);
    const ref = mode === 'signed' ? returned.handoff.operationRefs[0] : returned.handoff.actionOperationRefs[0];
    assert.equal(ref.operationId, task.operationId); assert.equal(ref.state, 'acknowledged');
    assert.equal(returned.reconciliation.operations[0].receiptState, 'acknowledged');
    assert.equal(duringReturn[0].body.eventId, task.operationId);
    assert.equal(duringReturn[0].body.payloadHash, mode === 'signed' ? returned.session.linkedOperations[0].payloadHash : returned.session.actionOperations[0].payloadHash);
    assert.equal(returned.reconciliation.automaticallyRetried, false); assert.equal(returned.reconciliation.currentPermissionEstablished, false);
    assert.equal(returned.remoteOperationsCanceled, false); assert.equal(returned.successFactsCreated, false);
    assert.equal(returned.session.paths.length, 4); assert.equal(returned.remote.participations.length, 0);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests WHERE id=$1', [task.taskId])).rows[0].n, 1);
  }
}));

test('lost acceptance ACK returns original participation and accepted diagnosis while resolution and verification remain separate', { timeout: 90000 }, async () => harness(async ({ f, p, hosts, requests, faults, now }) => {
  const owner = hosts.get(f).flow, provider = hosts.get(p).flow, task = taskDraft(now), session = await owner.start({ localTaskRef: 'original-chat:diagnosis' });
  await execute(owner, session, await prepare(owner, session, 'publish-task', task));
  const ps = await provider.start({ localTaskRef: 'provider-original', taskId: task.taskId }), participationId = id();
  const proposal = { kind: 'propose', eventId: id(), expectedTaskVersion: 1, participationId, subjectId: p.actor.subjectId, role: 'diagnosis', scopeVersion: 1, agreedScope: 'Diagnose selected parser boundary' };
  await execute(owner, session, await prepare(owner, session, 'participation-propose', proposal, { taskId: task.taskId }));
  await execute(provider, ps, await prepare(provider, ps, 'participation-event', { kind: 'confirm', eventId: id(), expectedParticipationVersion: 1, scopeVersion: 1 }, { taskId: task.taskId, participationId }));
  const caseId = id(), root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0, actorId: f.actor.subjectId, taskId: task.taskId,
    localRef: id(), title: 'Synthetic actual diagnostic facts', summary: 'Synthetic fixture, no real user acceptance', source: { kind: 'active-task', reference: task.taskId }, synthetic: true };
  const initial = { schemaVersion: 2, kind: 'intervention', eventId: id(), caseId, expectedVersion: 1, actorId: f.actor.subjectId, taskId: task.taskId,
    types: ['scope-clarification'], affectsAttemptIds: [], description: 'Only diagnosis is requested', sourceRefs: [], observedEffect: 'No patch or solution claimed' };
  const signedFact = (who, payload) => who.authorize(payload, 'case.teaser.publish', { objectId: payload.eventId, viewers: [who === f ? p.actor.subjectId : f.actor.subjectId] });
  await f.cases.createAndLinkTask(f.actor, { operationId: id(), taskId: task.taskId, expectedTaskVersion: (await f.assistance.getTask(f.actor, task.taskId)).version,
    case: await signedFact(f, root), initialFact: await signedFact(f, initial) });
  const diagnosis = { ...initial, eventId: id(), expectedVersion: 2, actorId: p.actor.subjectId, participationId, participationScopeVersion: 1, types: ['diagnosis'], description: 'Excluded a selected hypothesis' };
  await f.cases.submitV2(p.actor, await signedFact(p, diagnosis));
  const result = { schemaVersion: 2, kind: 'result-recorded', eventId: id(), caseId, expectedVersion: 3, actorId: p.actor.subjectId, taskId: task.taskId,
    participationId, participationScopeVersion: 1, origin: { kind: 'intervention', id: diagnosis.eventId, version: 1 }, scopeVersion: 1,
    deliverableRefs: [], reportedOutcome: 'partial', summary: 'Diagnosis useful, original work still unresolved', limitations: 'Synthetic bounded scope' };
  await f.cases.submitV2(p.actor, await signedFact(p, result));
  const delivered = { kind: 'deliver', eventId: id(), expectedParticipationVersion: 2, resultRef: { id: result.eventId, version: 1 }, interventionRefs: [{ id: diagnosis.eventId, version: 1 }], evidenceRefs: [], summary: 'Selected diagnostic result only' };
  await execute(provider, ps, await prepare(provider, ps, 'participation-event', delivered, { taskId: task.taskId, participationId }));
  const accepted = { kind: 'accept', eventId: id(), expectedParticipationVersion: 3, deliveryId: delivered.eventId, summary: 'Accepted diagnosis, no solution or independent test implied' };
  const preview = await prepare(owner, session, 'participation-event', accepted, { taskId: task.taskId, participationId });
  faults.losePath = `/v2/participations/${participationId}/events`;
  assert.equal((await execute(owner, session, preview)).state, 'unknown');
  faults.failReceipt = true;
  const receiptUnavailable = await returnToWork(owner, session);
  assert.equal(receiptUnavailable.state, 'refreshed', 'one unavailable receipt does not suppress the current readable Task');
  assert.equal(receiptUnavailable.remote.participations[0].state, 'accepted');
  assert.equal(receiptUnavailable.reconciliation.operations[0].receiptState, 'unavailable');
  assert.equal(receiptUnavailable.handoff.actionOperationRefs.find(row => row.operationId === accepted.eventId).state, 'unknown');
  faults.failReceipt = false;
  const beforeReturn = requests.length, returned = await returnToWork(owner, session), part = returned.remote.participations.find(row => row.participationId === participationId);
  assert.equal(returned.reconciliation.operations[0].operationId, accepted.eventId); assert.equal(returned.reconciliation.operations[0].state, 'acknowledged');
  assert.deepEqual(requests.slice(beforeReturn).map(row => row.path), ['/v2/tasks/receipt', `/v2/tasks/${task.taskId}`]);
  assert.equal(part.state, 'accepted'); assert.equal(part.deliveries[0].verification, 'not-provided'); assert.equal(part.deliveries[0].resolution, 'unresolved');
  assert.equal(part.deliveries[0].resultRef.id, result.eventId); assert.equal(returned.handoff.caseId, caseId);
  assert.equal(returned.handoff.actionOperationRefs.find(row => row.operationId === accepted.eventId).state, 'acknowledged');
  assert.equal(returned.successFactsCreated, false); assert.equal(returned.remoteOperationsCanceled, false);
  const facts = await f.cases.getV2(f.actor, caseId, { taskId: task.taskId });
  assert.equal(facts.attempts.length, 0); assert.equal(facts.resolution.status, 'unrecorded');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_events WHERE id=$1', [accepted.eventId])).rows[0].n, 1);
}));

test('receipt failure remains unknown and ACK cannot restore revoked current Task access', { timeout: 90000 }, async () => harness(async ({ f, hosts, requests, faults, now }) => {
  const { flow } = hosts.get(f), task = taskDraft(now), session = await flow.start({ localTaskRef: 'original-chat:private-source' });
  const signed = await f.authorize(task, 'assistance.publish', { objectId: task.operationId, visibility: 'Public', purpose: 'public-profile' });
  faults.losePath = '/v2/tasks'; await flow.publish(session.id, signed); faults.failReceipt = true;
  const unknown = await returnToWork(flow, session);
  assert.equal(unknown.remote, null); assert.equal(unknown.handoff.taskId, null); assert.equal(unknown.handoff.operationRefs[0].state, 'unknown');
  assert.equal(unknown.reconciliation.operations[0].receiptState, 'unavailable'); assert.equal(unknown.reconciliation.automaticallyRetried, false);
  faults.failReceipt = false; await f.consents.revoke(f.actor, signed.consentId);
  const beforeReturn = requests.length, revoked = await returnToWork(flow, session);
  assert.equal(revoked.handoff.taskId, task.taskId); assert.equal(revoked.handoff.operationRefs[0].state, 'acknowledged');
  assert.equal(revoked.state, 'unavailable'); assert.equal(revoked.remote, null); assert.equal(revoked.previousReceiptsDoNotProveCurrentAccess, true);
  assert.deepEqual(requests.slice(beforeReturn).map(row => row.path), ['/v2/tasks/receipt', `/v2/tasks/${task.taskId}`]);
  assert.equal(requests.filter(row => row.path === '/v2/tasks').length, 1);
}));

test('late old-connection receipt and concurrent local revision cannot become a current returned result', { timeout: 90000 }, async () => harness(async ({ f, hosts, requests, faults, now }) => {
  const { flow, connect } = hosts.get(f), task = taskDraft(now), session = await flow.start({ localTaskRef: 'original-chat:connection-switch' });
  const signed = await f.authorize(task, 'assistance.publish', { objectId: task.operationId, visibility: 'Public', purpose: 'public-profile' });
  faults.losePath = '/v2/tasks'; await flow.publish(session.id, signed);
  const receiptHold = { path: '/v2/tasks/receipt', entered: deferred(), release: deferred() }; faults.hold = receiptHold;
  const pendingReturn = returnToWork(flow, session); await receiptHold.entered.promise; connect(); receiptHold.release.resolve();
  const stale = await pendingReturn;
  assert.equal(stale.remote, null); assert.equal(stale.handoff.taskId, null); assert.equal(stale.handoff.operationRefs[0].state, 'unknown');
  assert.equal(stale.reconciliation.operations[0].receiptState, 'unavailable');
  const current = await returnToWork(flow, session); assert.equal(current.remote.taskId, task.taskId);
  const taskHold = { path: `/v2/tasks/${task.taskId}`, entered: deferred(), release: deferred() }; faults.hold = taskHold;
  const pendingRefresh = flow.refresh(session.id); await taskHold.entered.promise;
  await flow.pause(session.id, { expectedRevision: (await flow.get(session.id)).revision, state: 'paused' }); taskHold.release.resolve();
  await assert.rejects(pendingRefresh, /help_session_changed/);
  assert.equal((await flow.get(session.id)).pauseState, 'paused'); assert.equal(requests.filter(row => row.path === '/v2/tasks').length, 1);
}));

test('late absent receipt cannot overwrite the original publication ACK committed while that receipt was in flight', { timeout: 90000 }, async () => harness(async ({ f, hosts, requests, faults, now }) => {
  const { flow } = hosts.get(f), task = taskDraft(now), session = await flow.start({ localTaskRef: 'original-chat:publication-race' });
  const signed = await f.authorize(task, 'assistance.publish', { objectId: task.operationId, visibility: 'Public', purpose: 'public-profile' });
  const publicationHold = { path: '/v2/tasks', entered: deferred(), release: deferred() }; faults.beforeSend = publicationHold;
  const pendingPublication = flow.publish(session.id, signed); await publicationHold.entered.promise;
  const receiptHold = { path: '/v2/tasks/receipt', entered: deferred(), release: deferred() }; faults.hold = receiptHold;
  const pendingReceipt = flow.reconcile(session.id, task.operationId); await receiptHold.entered.promise;
  publicationHold.release.resolve(); assert.equal((await pendingPublication).publication.state, 'acknowledged');
  receiptHold.release.resolve(); const reconciled = await pendingReceipt;
  assert.equal(reconciled.receipt.state, 'absent', 'this historical observation predates the actual commit');
  assert.equal(reconciled.session.linkedOperations[0].state, 'acknowledged'); assert.equal(reconciled.session.taskId, task.taskId);
  const returned = await returnToWork(flow, session); assert.equal(returned.remote.taskId, task.taskId);
  assert.equal(returned.handoff.operationRefs[0].state, 'acknowledged'); assert.equal(requests.filter(row => row.path === '/v2/tasks').length, 1);
}));
