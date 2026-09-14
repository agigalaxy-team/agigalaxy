import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { createNativeA2aHostV2 } from '../src/host-flow-v2.mjs';
import { hash } from '../src/journal.mjs';
import { sdkPeer } from './sdk-peer.mjs';

test('actual Participation/Intervention origin imports own Result; partial projection is not absence; revoked source stops future work', async t => {
  const scopes = ['binding', 'consent', 'case-teaser', 'assistance'];
  const f = await serviceFixture(scopes), p = await serviceFixture(scopes, f.db, { migrateDatabase: false });
  t.after(() => f.db.close()); const peer = await sdkPeer(); t.after(() => peer.close());
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-a2a-participation-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const grant = (who, e, viewers = []) => who.authorize(e, 'case.teaser.publish', { objectId: e.eventId, viewers });
  const taskGrant = (who, e, viewers = []) => who.authorize(e, 'assistance.publish', { objectId: e.operationId ?? e.eventId, viewers });
  const taskId = randomUUID(), caseId = randomUUID(), attemptId = randomUUID(), interventionId = randomUUID(), participationId = randomUUID();
  const task = { operationId: randomUUID(), taskId, caseId: null, intent: 'diagnosis', title: 'Synthetic peer assistance', summary: 'Selected scope',
    workContext: { goal: 'inspect', currentSituation: 'requesting', attemptRefs: [] }, visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 1000 };
  await f.assistance.createTask(f.actor, await taskGrant(f, task, [p.actor.subjectId]));
  const root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0, taskId, actorId: f.actor.subjectId,
    localRef: randomUUID(), title: 'Synthetic task Case', summary: 'Owner-private root', source: { kind: 'active-task', reference: taskId }, synthetic: true };
  const initial = { schemaVersion: 2, kind: 'intervention', eventId: randomUUID(), caseId, expectedVersion: 1, taskId, actorId: f.actor.subjectId,
    types: ['scope-clarification'], affectsAttemptIds: [], description: 'Owner-private initial work', sourceRefs: [], observedEffect: 'scope understood' };
  await f.cases.createAndLinkTask(f.actor, { operationId: randomUUID(), taskId, expectedTaskVersion: 1,
    case: await grant(f, root), initialFact: await grant(f, initial) });
  const proposal = { eventId: randomUUID(), expectedTaskVersion: 1, kind: 'propose', participationId, subjectId: p.actor.subjectId,
    role: 'diagnosis', scopeVersion: 1, agreedScope: 'Call explicit external peer with selected text' };
  await f.assistance.proposeParticipation(f.actor, taskId, await taskGrant(f, proposal, [p.actor.subjectId]));
  await f.assistance.submitParticipationEvent(p.actor, participationId, await taskGrant(p,
    { eventId: randomUUID(), expectedParticipationVersion: 1, kind: 'confirm', scopeVersion: 1 }, [f.actor.subjectId]));
  const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: attemptId, caseId, expectedVersion: 2, taskId, participationId,
    participationScopeVersion: 1, actorId: p.actor.subjectId, role: 'diagnosis', strategy: 'External selected operation',
    inputScopeSummary: 'Reviewed text only', permissionScope: ['selected-text'] };
  await f.cases.submitV2(p.actor, await grant(p, attempt));
  const intervention = { schemaVersion: 2, kind: 'intervention', eventId: interventionId, caseId, expectedVersion: 3, taskId, participationId,
    participationScopeVersion: 1, actorId: p.actor.subjectId, types: ['tool-introduction'], affectsAttemptIds: [attemptId],
    description: 'Introduced approved A2A peer', sourceRefs: [], observedEffect: 'Can request selected external help' };
  const ig = await grant(p, intervention); await f.cases.submitV2(p.actor, ig);
  const runtime = { api: { endpoint: f.access.endpoint, snapshot: () => ({ subjectId: p.actor.subjectId, bindingId: p.actor.bindingId }),
    call: async (path, input) => {
      if (path === `/v2/tasks/${taskId}`) return f.assistance.getTask(p.actor, taskId);
      if (path === `/v2/cases/${caseId}/read`) return f.cases.getV2(p.actor, caseId, input);
      if (path === '/v2/cases/events') return f.cases.submitV2(p.actor, input);
      throw new Error('unexpected fixture route');
    } }, status: async () => ({ identity: p.actor.subjectId }), authorize: input => p.authorize(JSON.parse(input.payloadJson), input.action,
      { id: input.requestId, objectId: input.objectId, visibility: input.visibility, viewers: input.viewers }) };
  const options = { runtime, directory, peers: [{ id: 'fixture', endpoint: peer.endpoint, tenant: 'fixture', agentCard: peer.card,
    cardHash: hash(JSON.stringify(peer.card)), trustExpiresAt: Date.now() + 60000, peerPrincipal: 'external-fixture-user' }],
    readPeerAuthorization: async () => ({ subjectId: p.actor.subjectId, peerPrincipal: 'external-fixture-user', credential: 'synthetic-external-token' }), post: peer.post };
  const host = createNativeA2aHostV2(options);
  const selected = { taskId, caseId, attemptId, attemptVersion: 1, interventionRef: { id: interventionId, version: 1 }, text: 'complete' };
  const sent = await host.execute(await host.prepare('fixture', 'send', selected), { confirmed: true });
  assert.equal(sent.factContext.participationId, participationId);
  const prepared = await host.prepare('fixture', 'result', { associationId: sent.id, summary: 'Selected peer tool completed; diagnosis remains a claim', reportedOutcome: 'partial' });
  assert.deepEqual(prepared.draft.event.origin, { kind: 'intervention', id: interventionId, version: 1 });
  assert.equal((await host.read('fixture', 'reconcile-result', sent.id)).state, 'unavailable', 'private owner events mean projection incomplete');
  const receipt = await host.execute(prepared, { confirmed: true }); assert.equal(receipt.verification, 'not-provided');
  const view = await f.cases.getV2(p.actor, caseId, { taskId });
  assert.equal(view.results[0].participationId, participationId); assert.equal(view.resolution.status, 'unrecorded');
  await f.consents.revoke(p.actor, ig.consentId);
  assert.equal((await host.read('fixture', 'reconcile-result', sent.id)).state, 'unavailable');
  const before = peer.requests.length; await assert.rejects(host.read('fixture', 'poll', sent.id), /Intervention/);
  assert.equal(peer.requests.length, before);
});
