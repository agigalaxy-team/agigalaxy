import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceFixture } from './service-fixture.mjs';
import { createLocalHelpStoreV2 } from '../src/local-help-store-v2.mjs';
import { createHelpActionFlowV2 } from '../src/help-action-flow-v2.mjs';
import { digest } from '../src/shared/digest.mjs';

test('expired exact help authorization renews only its request ID after an absent receipt; stale preview and unknown renewal are refused', async () => {
  const f = await serviceFixture(['binding', 'consent', 'assistance', 'case-teaser']);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-help-renewal-'));
  // Isolate the real Consent clock from transport credential lifetime: this
  // verifies authorizations, rather than synthetic fresh session credentials.
  let clock = f.now, authorizations = 0, dropBeforeWrite = false, dispatches = 0;
  f.consents.now = () => clock;
  const saved = new Map();
  await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify(f.genesis));
  const store = createLocalHelpStoreV2({ dataDirectory: directory, endpoint: f.access.endpoint, subjectId: f.actor.subjectId, now: () => clock });
  const flow = createHelpActionFlowV2({ store, now: () => clock, review: async () => ({ offers: [] }),
    actions: { createTask: async signed => { dispatches++; if (dropBeforeWrite) { dropBeforeWrite = false; throw new Error('Synthetic before dispatch'); }
      return f.assistance.createTask(f.actor, signed); }, taskReceipt: query => f.assistance.taskReceipt(f.actor, query) },
    authorize: async input => {
      authorizations++;
      const prior = saved.get(input.requestId);
      if (prior) { assert.deepEqual(prior.input, input, 'native authorization IDs never change their exact signed input'); return prior.submission; }
      const signed = await f.authorize(JSON.parse(input.payloadJson), input.action, { id: input.requestId, objectId: input.objectId,
        payloadHash: digest(input.payloadJson), issuedAt: clock, expiresAt: input.expiresAt, visibility: input.visibility, viewers: input.viewers });
      const submission = { ...signed, payloadJson: input.payloadJson };
      saved.set(input.requestId, { input, submission }); return submission;
    } });
  const task = () => ({ operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'proactive-review', title: 'Synthetic draft', summary: 'Only exact selected bytes',
    workContext: { goal: 'Review parser', currentSituation: 'No failure', attemptRefs: [] }, visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: f.now + 20000 });
  const execute = (session, preview, nonce = preview.authorizationRequestId) => flow.executeAction(session.id,
    { operationId: preview.operationId, payloadHash: preview.payloadHash, authorizationRequestId: nonce });
  try {
    const session = await store.create({ localTaskRef: 'original:expired-draft' }), payload = task();
    const bytes = JSON.stringify(payload, null, 2), prepared = await flow.prepareAction(session.id, { kind: 'publish-task', payloadJson: bytes });
    clock += 3601;
    await assert.rejects(execute(session, prepared), /help_authorization_refresh_required/);
    assert.equal(authorizations, 0);
    const renewed = await flow.prepareAction(session.id, prepared.prepareInput);
    assert.equal(renewed.operationId, prepared.operationId); assert.equal(renewed.payloadHash, prepared.payloadHash);
    assert.notEqual(renewed.authorizationRequestId, prepared.authorizationRequestId);
    assert.equal(renewed.prepareInput.payloadJson, bytes, 'whitespace and original bytes survive renewal');
    assert.equal(renewed.authorizationExpiresAt, clock + 3600);
    await assert.rejects(execute(session, prepared), /help_authorization_preview_changed/);
    assert.equal(authorizations, 0);
    dropBeforeWrite = true;
    assert.equal((await execute(session, renewed)).state, 'unknown');
    await assert.rejects(flow.prepareAction(session.id, { ...renewed.prepareInput, authorizationRequestId: randomUUID() }), /help_authorization_renewal_requires_absence/);
    assert.equal((await flow.reconcileAction(session.id, { operationId: payload.operationId })).receipt.state, 'absent');
    const originalConsent = saved.get(renewed.authorizationRequestId).submission.consentId;
    await f.consents.revoke(f.actor, originalConsent);
    const fresh = await flow.prepareAction(session.id, { ...renewed.prepareInput, authorizationRequestId: randomUUID() });
    assert.equal(fresh.payloadHash, prepared.payloadHash); assert.equal(fresh.operationId, prepared.operationId);
    assert.equal((await execute(session, fresh)).receipt.taskId, payload.taskId);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests WHERE id=$1', [payload.taskId])).rows[0].n, 1);
    assert.equal(dispatches, 2); assert.equal(authorizations, 2);
    const acknowledged = await flow.actionPreview(session.id, payload.operationId);
    assert.equal(Object.hasOwn(acknowledged, 'prepareInput'), false);
    assert.equal(Object.hasOwn(acknowledged, 'payload'), false);
    assert.equal((await execute(session, acknowledged)).receipt.taskId, payload.taskId);
    assert.equal(authorizations, 2, 'acknowledged receipt never signs again');
    const contextTask = task(), participationId = randomUUID(), scopeEventId = randomUUID();
    const contextSession = await store.create({ localTaskRef: 'original:bounded-material', taskId: contextTask.taskId });
    let materialWrites = 0;
    const contextFlow = createHelpActionFlowV2({ store, now: () => clock, review: async () => ({ offers: [] }),
      authorize: async () => { materialWrites++; throw new Error('must not sign'); },
      actions: { getTask: async () => ({ schemaVersion: 2, taskId: contextTask.taskId, requesterId: f.actor.subjectId, version: 1,
        state: 'open', paused: false, caseId: null, participations: [{ participationId, subjectId: 'GUID' + 'A'.repeat(28),
          state: 'active', version: 1, scopeVersion: 1, scopeEventId, agreedScope: 'Selected material only' }] }) } });
    const context = { schemaVersion: 2, id: randomUUID(), taskId: contextTask.taskId, participationId, participantId: 'GUID' + 'A'.repeat(28),
      scopeVersion: 1, scopeEventId, expiresAt: clock + 60, materials: [{ id: randomUUID(), label: 'Selected', mediaType: 'text/plain', content: 'Private excerpt' }] };
    const bounded = await contextFlow.prepareAction(contextSession.id, { kind: 'context-grant', payloadJson: JSON.stringify(context) });
    clock += 61;
    await assert.rejects(contextFlow.prepareAction(contextSession.id, bounded.prepareInput), /help_context_scope_changed/);
    await assert.rejects(contextFlow.executeAction(contextSession.id, { operationId: bounded.operationId, payloadHash: bounded.payloadHash }), /help_authorization_refresh_required/);
    assert.equal(materialWrites, 0, 'authorization renewal cannot extend the business material expiry');
  } finally { await rm(directory, { recursive: true, force: true }); await f.db.close(); }
});
