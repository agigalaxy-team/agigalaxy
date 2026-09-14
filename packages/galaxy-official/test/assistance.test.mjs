import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAssistance, applyAssistance } from '../src/domain/assistance.mjs';
const requester = 'GUID' + '1'.repeat(28), provider = 'GUID' + '2'.repeat(28), stranger = 'GUID' + '3'.repeat(28);
const request = () => ({ id: randomUUID(), caseId: randomUUID(), title: 'Build issue', problem: 'Fails to compile',
  attemptedApproaches: ['Changed configuration'], scope: 'Diagnose failure', visibility: 'Private', collaboration: 'basic-bounty',
  budget: { mode: 'range', minimum: '10.01', maximum: '20', unit: 'external-unit' }, enrollmentExpiresAt: 2000 });

test('assistance requires requester selection and provider confirmation, records delivery and bilateral resolution', () => {
  let state = createAssistance(requester, request(), 1000);
  const original = structuredClone(state);
  const event = (kind, fields = {}) => ({ id: randomUUID(), expectedVersion: state.version, kind, ...fields });
  const offer = event('offer', { proposal: 'Investigate', scope: 'Read logs', quote: { mode: 'fixed', amount: '12.50', unit: 'external-unit' } });
  state = applyAssistance(state, provider, offer, 1001);
  assert.deepEqual(original.events, []); assert.equal(state.state, 'open');
  assert.equal(applyAssistance(state, provider, offer, 1002), state);
  state = applyAssistance(state, requester, event('shortlist', { offerIds: [offer.id] }), 1002);
  state = applyAssistance(state, requester, event('select', { offerId: offer.id }), 1003);
  assert.equal(state.state, 'awaiting-confirmation'); assert.equal(state.contextAccessGranted, false);
  assert.throws(() => applyAssistance(state, requester, event('confirm'), 1004));
  state = applyAssistance(state, provider, event('confirm'), 1004);
  state = applyAssistance(state, requester, event('change-scope', { scope: 'Read logs and suggest patch', reason: 'Agreed extension' }), 1005);
  assert.equal(state.agreedScope, 'Read logs');
  state = applyAssistance(state, provider, event('confirm-scope'), 1006);
  const delivery = event('deliver', { attemptId: randomUUID(), summary: 'Patch proposal', evidenceIds: [] });
  assert.throws(() => applyAssistance(state, stranger, delivery, 1007));
  state = applyAssistance(state, provider, delivery, 1007);
  state = applyAssistance(state, requester, event('accept', { deliveryId: delivery.id, summary: 'Accepted by requester' }), 1008);
  state = applyAssistance(state, requester, event('dispute', { reason: 'Regression found' }), 1009);
  const proposal = event('propose-resolution', { summary: 'Record remaining limitation' });
  state = applyAssistance(state, provider, proposal, 1010);
  assert.throws(() => applyAssistance(state, provider, event('confirm-resolution', { proposalId: proposal.id }), 1011));
  state = applyAssistance(state, requester, event('confirm-resolution', { proposalId: proposal.id }), 1011);
  assert.equal(state.state, 'resolved'); assert.equal(state.delivery.id, delivery.id);
  assert.equal(state.paymentExecuted, false); assert.equal(state.capabilityVerified, false);
  const rebuilt = state.events.reduce((current, row) => applyAssistance(current, row.actorId, row.event, row.at), original);
  assert.deepEqual(rebuilt, state);
});
test('enrollment expiry and invalid budgets cannot silently start a collaboration', () => {
  const state = createAssistance(requester, request(), 1000);
  assert.throws(() => applyAssistance(state, provider, { id: randomUUID(), expectedVersion: 1, kind: 'offer', proposal: 'Late', scope: 'Late' }, 2000), /expired/);
  assert.equal(applyAssistance(state, requester, { id: randomUUID(), expectedVersion: 1, kind: 'expire' }, 2000).state, 'expired');
  assert.throws(() => createAssistance(requester, { ...request(), budget: { mode: 'range', minimum: '20', maximum: '10', unit: 'unit' } }, 1000));
  assert.throws(() => createAssistance(requester, { ...request(), rawContext: 'not part of teaser' }, 1000));
});
