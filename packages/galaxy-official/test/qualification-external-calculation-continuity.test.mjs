import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, task, experience, review, xg, ag, scopes, capabilityId } from './qualification-v2-workflow.mjs';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { recordRuntimeConfig, runtimeConfigSnapshot } from '../src/operations/runtime-config-audit.mjs';
import { HonorService } from "../src/records/honor.mjs";
import { HonorV2Service } from "../src/records/honor-v2.mjs";
import { digest } from '../src/shared/digest.mjs';

// All identities, policies, reviewer registration and external material are
// fictional local fixtures. markedReal models the non-synthetic field contract
// in an isolated database; it does not attest to real work or real expertise.
// Binding/session/Consent signatures, HTTP and canonical service methods execute.
async function setup({ markedReal = false } = {}) {
  const { f: candidate, p: reviewer, policy } = await fixture(null, { extraScopes: ['history'] });
  let api;
  try {
    const requester = await serviceFixture([...scopes, 'history'], candidate.db, { migrateDatabase: false, syntheticCommunityQuota: false });
    candidate.qualificationRequests.qualification = candidate.qualification.v2;
    candidate.qualificationRequests.calculations = candidate.qualificationCalculations;
    candidate.experienceReviews.reviewers = candidate.experienceReviews.reviewers.map(r => ({ ...r, synthetic: !markedReal }));
    const registration = async reviewers => recordRuntimeConfig(candidate.db, {
      endpoint: candidate.access.endpoint, component: 'api', experienceReviewers: reviewers, qualificationPolicies: [policy],
      snapshot: runtimeConfigSnapshot({ governance: { experienceReviewers: reviewers, qualificationPolicies: [policy] } }),
    });
    await registration(candidate.experienceReviews.reviewers);
    await candidate.experienceReviews.useRegistry();
    await candidate.qualification.useRegistry();
    api = createApi(candidate);
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const post = async (who, path, body, { dropAcknowledgement = false } = {}) => {
      const response = await fetch(`http://127.0.0.1:${api.address().port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.credential}` }, body: JSON.stringify(body),
      });
      const value = { status: response.status, body: await response.json() };
      if (dropAcknowledgement && response.ok) throw Error('fixture: original HTTP commit acknowledgement lost');
      return value;
    };
    const ok = async (who, path, body) => { const r = await post(who, path, body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    const target = task(candidate, true);
    await ok(requester, '/v2/tasks', await ag(requester, target, [candidate.actor.subjectId]));
    const declaration = { ...experience(candidate), synthetic: !markedReal, kind: 'external-work',
      actualIntervention: 'FICTIONAL TEST ONLY: private external repair text', scope: 'FICTIONAL TEST ONLY: bounded diagnosis',
      source: { ...experience(candidate).source, stableRecord: 'fixture:' + randomUUID(), originalAuthor: 'FICTIONAL TEST AUTHOR' } };
    const signedDeclaration = await xg(candidate, declaration, [reviewer.actor.subjectId]);
    await ok(candidate, '/v2/experience/submit', signedDeclaration);
    const attestation = { ...review(reviewer, declaration), synthetic: !markedReal, scope: declaration.scope,
      method: 'FICTIONAL TEST REVIEW PROCEDURE', observations: 'FICTIONAL TEST: this bounded source only' };
    const signedReview = await xg(reviewer, attestation, [candidate.actor.subjectId]);
    await ok(reviewer, '/v2/experience/submit', signedReview);
    const evidence = { externalReviewRefs: [{ id: attestation.id, version: 1 }] };
    const expiresAt = new Date((candidate.now + 300) * 1000).toISOString();
    const planInput = { taskId: target.taskId, participationIds: [], externalReviewRefs: evidence.externalReviewRefs, expiresAt };
    const getPlan = () => ok(candidate, '/v2/qualification/permission-requests/plan', planInput);
    const signGrant = (who, data) => who.authorize(data, data.kind === 'compute' ? 'qualification.compute' : 'qualification.source-permission', {
      objectId: data.id, viewers: [data.candidateId, data.recipientId].filter(id => id !== who.actor.subjectId),
    });
    const signRequest = (who, data, viewers) => who.authorize(data, 'qualification.request', { objectId: data.eventId, viewers });
    const query = (extra = {}) => ({ taskId: target.taskId, subjectId: candidate.actor.subjectId, evidence, ...extra });
    const authorizeCalculation = async () => {
      const plan = await getPlan();
      const author = plan.authors.find(a => a.sourceAuthorId === reviewer.actor.subjectId);
      assert.ok(author);
      const permission = { taskId: plan.taskId, candidateId: plan.candidateId, recipientId: plan.recipientId, purpose: plan.purpose,
        disclosure: plan.disclosure, expiresAt: plan.expiresAt, sourceRefs: author.sourceRefs, kind: 'source-permission', id: randomUUID() };
      const signedPermission = await signGrant(reviewer, permission);
      await ok(reviewer, '/v2/qualification/calculation-permissions', signedPermission);
      const ready = await getPlan(); assert.equal(ready.ready, true);
      const compute = { ...ready.compute, id: randomUUID() }, signedCompute = await signGrant(candidate, compute);
      await ok(candidate, '/v2/qualification/calculation-permissions', signedCompute);
      return { permission, signedPermission, compute, signedCompute,
        selected: { ...query(), evidence: { ...ready.compute.evidence, calculationGrantId: compute.id } } };
    };
    const close = async () => { await new Promise((resolve, reject) => api.close(e => e ? reject(e) : resolve())); await candidate.db.close(); };
    return { candidate, reviewer, requester, target, declaration, attestation, signedDeclaration, signedReview, evidence, planInput,
      getPlan, signGrant, signRequest, query, post, ok, registration, authorizeCalculation, close };
  } catch (error) {
    if (api) await new Promise(resolve => api.close(resolve));
    await candidate.db.close(); throw error;
  }
}

function withoutSources(value, context) {
  const json = JSON.stringify(value);
  for (const hidden of [context.declaration.actualIntervention, context.declaration.scope, context.declaration.id,
    context.declaration.operationId, context.attestation.id, context.attestation.operationId, context.reviewer.actor.subjectId,
    context.attestation.method, context.attestation.observations]) assert.equal(json.includes(hidden), false, hidden);
  assert.equal(value.capabilityVerified, false);
  assert.equal(value.expertiseCertified, false);
  assert.equal(value.automaticSelection, false);
}

test('private external source authors explicitly license a bounded calculation; original ACK and simulation grant no source reading or selection', async () => {
  const f = await setup();
  const { candidate: c, reviewer: r, requester: n } = f;
  try {
    assert.equal((await f.ok(c, '/v2/experience/read', { id: f.attestation.id, version: 1 })).referenceStatus, 'current');
    assert.equal((await f.post(n, '/v2/experience/read', { id: f.attestation.id, version: 1 })).status, 404);
    const ordinary = await f.ok(n, '/v2/qualification/evaluate', f.query({ includeSimulation: true }));
    assert.equal(ordinary.simulation.state, 'insufficient-evidence');
    const plan = await f.getPlan();
    assert.equal(plan.ready, false);
    assert.equal(plan.authors.length, 1);
    assert.equal(plan.ownMaterials.length, 1);
    assert.equal(plan.authors[0].sourceRefs[0].id, f.attestation.operationId);
    assert.equal(plan.compute.sourceRefs.find(ref => ref.id === f.declaration.operationId).payloadHash, digest(f.signedDeclaration.payloadJson));
    const request = { eventId: randomUUID(), requestId: randomUUID(), kind: 'request', expectedVersion: 0,
      taskId: plan.taskId, sourceAuthorId: r.actor.subjectId, participationIds: [], externalReviewRefs: plan.compute.evidence.externalReviewRefs,
      sourceRefs: plan.authors[0].sourceRefs, expiresAt: plan.expiresAt, purpose: 'request-scoped-qualification-permission-only; no-permission-granted' };
    await f.ok(c, '/v2/qualification/permission-requests/events', await f.signRequest(c, request, [r.actor.subjectId]));
    const view = await f.ok(r, '/v2/qualification/permission-requests/read', { requestId: request.requestId });
    assert.equal(view.target, null, 'reviewer gains no access to the private target task');
    assert.equal(view.permissionGranted, false);
    assert.deepEqual(view.grant.sourceRefs, request.sourceRefs);
    const permission = { ...view.grant, id: randomUUID() }, signedPermission = await f.signGrant(r, permission);
    await f.ok(r, '/v2/qualification/calculation-permissions', signedPermission);
    const response = { eventId: randomUUID(), requestId: request.requestId, kind: 'record-permission', expectedVersion: 1, grantId: permission.id };
    await f.ok(r, '/v2/qualification/permission-requests/events', await f.signRequest(r, response, [c.actor.subjectId]));
    const ready = await f.getPlan(); assert.equal(ready.ready, true);
    assert.deepEqual(ready.compute.evidence.externalReviewRefs, [{ id: f.attestation.id, version: 1 }]);
    const compute = { ...ready.compute, id: randomUUID() }, signedCompute = await f.signGrant(c, compute);
    await assert.rejects(f.post(c, '/v2/qualification/calculation-permissions', signedCompute, { dropAcknowledgement: true }), /acknowledgement lost/);
    const receipt = await f.ok(c, '/v2/qualification/calculation-receipt', { operationId: compute.id, payloadHash: digest(signedCompute.payloadJson) });
    assert.equal(receipt.state, 'acknowledged');
    assert.equal(receipt.currentReadPermissionConfirmed, false);
    assert.equal(Number((await c.db.query('SELECT count(*) n FROM qualification_calculation_grants WHERE id=$1', [compute.id])).rows[0].n), 1);
    const selected = { ...f.query({ includeSimulation: true }), evidence: { ...ready.compute.evidence, calculationGrantId: compute.id } };
    for (const who of [c, n]) {
      const bounded = await f.ok(who, '/v2/qualification/evaluate', selected);
      assert.equal(bounded.state, 'insufficient-evidence');
      assert.equal(bounded.simulation.state, 'satisfied');
      assert.equal(bounded.simulation.grantsParticipation, false);
      withoutSources(bounded, f);
    }
    assert.equal((await f.post(r, '/v2/qualification/evaluate', selected)).status, 404);
    assert.equal((await f.post(n, '/v2/experience/read', { id: f.declaration.id })).status, 404);
    assert.equal((await f.post(n, '/v2/experience/read', { id: f.attestation.id })).status, 404);
    const application = { taskId: f.target.taskId, event: { eventId: randomUUID(), kind: 'apply', expectedTaskVersion: 1,
      proposal: 'FICTIONAL candidate application', scope: 'bounded diagnosis', qualificationEvidence: selected.evidence } };
    await f.ok(c, `/v2/tasks/${f.target.taskId}/events`, await ag(c, application, [n.actor.subjectId]));
    const proposal = { eventId: randomUUID(), kind: 'propose', expectedTaskVersion: 2, participationId: randomUUID(),
      subjectId: c.actor.subjectId, role: 'diagnosis', scopeVersion: 1, agreedScope: 'bounded diagnosis', applicationId: application.event.eventId };
    const attempted = await f.post(n, `/v2/tasks/${f.target.taskId}/participations`, await ag(n, proposal, [c.actor.subjectId]));
    assert.equal(attempted.status, 403); assert.equal(attempted.body.error, 'qualification_required');
    assert.equal(Number((await c.db.query('SELECT count(*) n FROM task_participations WHERE id=$1', [proposal.participationId])).rows[0].n), 0);
  } finally { await f.close(); }
});

test('marked-real contract fixtures allow explicit selection but reviewer removal and original source revocation are rechecked before confirmation; Honor remains independent', async () => {
  const f = await setup({ markedReal: true });
  const { candidate: c, requester: n } = f;
  try {
    const calc = await f.authorizeCalculation();
    let bounded = await f.ok(n, '/v2/qualification/evaluate', calc.selected);
    assert.equal(bounded.state, 'satisfied'); assert.equal(bounded.counts.distinctRelevantExperiences, 1); withoutSources(bounded, f);
    const application = { taskId: f.target.taskId, event: { eventId: randomUUID(), kind: 'apply', expectedTaskVersion: 1,
      proposal: 'FICTIONAL marked-real contract application', scope: 'bounded diagnosis', qualificationEvidence: calc.selected.evidence } };
    await f.ok(c, `/v2/tasks/${f.target.taskId}/events`, await ag(c, application, [n.actor.subjectId]));
    const proposal = { eventId: randomUUID(), kind: 'propose', expectedTaskVersion: 2, participationId: randomUUID(),
      subjectId: c.actor.subjectId, role: 'diagnosis', scopeVersion: 1, agreedScope: 'bounded diagnosis', applicationId: application.event.eventId };
    const signedProposal = await ag(n, proposal, [c.actor.subjectId]);
    await f.registration([]);
    const unavailable = await f.post(n, `/v2/tasks/${f.target.taskId}/participations`, signedProposal);
    assert.equal(unavailable.status, 403); assert.equal(unavailable.body.error, 'qualification_required');
    await f.registration(c.experienceReviews.reviewers);
    await f.ok(n, `/v2/tasks/${f.target.taskId}/participations`, signedProposal);
    const confirmation = { eventId: randomUUID(), kind: 'confirm', expectedParticipationVersion: 1, scopeVersion: 1 };
    const signedConfirmation = await ag(c, confirmation, [n.actor.subjectId]);
    await f.registration([]);
    const refused = await f.post(c, `/v2/participations/${proposal.participationId}/events`, signedConfirmation);
    assert.equal(refused.status, 403); assert.equal(refused.body.error, 'qualification_required');
    assert.equal((await c.db.query('SELECT version,snapshot FROM task_participations WHERE id=$1', [proposal.participationId])).rows[0].snapshot.state, 'awaiting-counterparty');
    await f.registration(c.experienceReviews.reviewers);
    await f.ok(c, `/v2/participations/${proposal.participationId}/events`, signedConfirmation);
    const rule = { id: 'fixture-open-contribution', version: '1', sourceProfile: 'facts-v2', title: 'FICTIONAL RULE', communityId: 'fixture', capabilityId,
      kind: 'open-contributor', members: [c.actor.subjectId, n.actor.subjectId], notBefore: c.now - 1, notAfter: c.now + 1000,
      windowFrom: c.now - 86400, windowUntil: c.now + 1, minAcceptedCases: 1, minProofs: 0, repositories: [] };
    c.honor = new HonorService(c.access, c.assistance, c.proofs, [rule]);
    c.honor.v2 = new HonorV2Service(c.honor, { qualification: c.qualification.v2, sharing: c.contributionSharing });
    const honor = await c.honor.v2.query(c.actor, { ruleId: rule.id, ruleVersion: '1', subjectId: c.actor.subjectId });
    assert.equal(honor.card.status, 'insufficient-evidence'); assert.equal(honor.card.acceptedCases, 0); assert.equal(honor.card.qualificationGranted, false);
    await f.ok(c, `/v1/consents/${f.signedDeclaration.consentId}/revoke`, {});
    const revoked = await f.post(n, '/v2/qualification/evaluate', calc.selected);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.state, 'insufficient-evidence'); withoutSources(revoked.body, f);
    const original = await f.ok(c, '/v2/qualification/calculation-receipt', { operationId: calc.compute.id, payloadHash: digest(calc.signedCompute.payloadJson) });
    assert.equal(original.state, 'acknowledged'); assert.equal(original.currentReadPermissionConfirmed, false);
    assert.equal((await c.db.query('SELECT snapshot FROM task_participations WHERE id=$1', [proposal.participationId])).rows[0].snapshot.state, 'active', 'withdrawn source does not rewrite accepted participation history');
    assert.equal((await c.db.query('SELECT payload_text,payload_hash FROM experience_events WHERE operation_id=$1', [f.declaration.operationId])).rows[0].payload_text, f.signedDeclaration.payloadJson);
    bounded = await f.ok(c, '/v2/qualification/evaluate', f.query());
    assert.equal(bounded.state, 'insufficient-evidence');
  } finally { await f.close(); }
});

test('licensed external evaluation keeps exact source versions, hashes, authors, recipient and current dependency scope', async () => {
  const f = await setup({ markedReal: true });
  const { candidate: c, reviewer: r, requester: n } = f;
  try {
    const initial = await f.getPlan();
    const draft = { ...initial.compute, id: randomUUID() };
    const denied = await f.post(c, '/v2/qualification/calculation-permissions', await f.signGrant(c, draft));
    assert.equal(denied.body.error, 'qualification_source_permission_required');
    const fakeAuthor = { ...draft, id: randomUUID(), kind: 'source-permission', sourceRefs: initial.authors[0].sourceRefs };
    delete fakeAuthor.permissionIds; delete fakeAuthor.evidence;
    assert.equal((await f.post(c, '/v2/qualification/calculation-permissions', await f.signGrant(c, fakeAuthor))).body.error, 'qualification_source_author_required');
    const calc = await f.authorizeCalculation();
    const wrongHash = { ...calc.compute, id: randomUUID(), sourceRefs: calc.compute.sourceRefs.map((ref, i) => i ? ref : { ...ref, payloadHash: '0'.repeat(64) }) };
    assert.equal((await f.post(c, '/v2/qualification/calculation-permissions', await f.signGrant(c, wrongHash))).body.error, 'qualification_source_unavailable');
    const incomplete = { ...calc.compute, id: randomUUID(), sourceRefs: calc.compute.sourceRefs.filter(ref => ref.id !== f.declaration.operationId) };
    await f.ok(c, '/v2/qualification/calculation-permissions', await f.signGrant(c, incomplete));
    const incompleteResult = await f.ok(n, '/v2/qualification/evaluate', { ...calc.selected, evidence: { ...calc.selected.evidence, calculationGrantId: incomplete.id } });
    assert.equal(incompleteResult.state, 'insufficient-evidence'); withoutSources(incompleteResult, f);
    const altered = await f.post(n, '/v2/qualification/evaluate', { ...calc.selected, evidence: { ...calc.selected.evidence, externalReviewRefs: [{ id: f.attestation.id, version: 2 }] } });
    assert.equal(altered.body.error, 'qualification_calculation_evidence_mismatch');
    const correction = { ...f.declaration, operationId: randomUUID(), expectedVersion: 1, reason: 'FICTIONAL source correction',
      source: { ...f.declaration.source, contentVersion: '2' } };
    await f.ok(c, '/v2/experience/submit', await xg(c, correction, [r.actor.subjectId]));
    const stale = await f.ok(n, '/v2/qualification/evaluate', calc.selected);
    assert.equal(stale.state, 'insufficient-evidence'); withoutSources(stale, f);
    assert.equal((await f.post(c, '/v2/qualification/permission-requests/plan', f.planInput)).body.error, 'qualification_review_unavailable');
    const rereview = { ...f.attestation, operationId: randomUUID(), expectedVersion: 1, reason: 'FICTIONAL current-version review', experienceRef: { id: f.declaration.id, version: 2 } };
    await f.ok(r, '/v2/experience/submit', await xg(r, rereview, [c.actor.subjectId]));
    const currentRefs = [{ id: f.attestation.id, version: 2 }];
    const next = await f.ok(c, '/v2/qualification/permission-requests/plan', { ...f.planInput, externalReviewRefs: currentRefs });
    assert.equal(next.ready, false, 'old reviewer permission does not authorize the new exact review operation');
    assert.ok(next.compute.sourceRefs.some(ref => ref.id === correction.operationId));
    assert.ok(next.compute.sourceRefs.some(ref => ref.id === rereview.operationId));
    const otherTask = task(c, true);
    await f.ok(n, '/v2/tasks', await ag(n, otherTask, [c.actor.subjectId]));
    assert.equal((await f.post(n, '/v2/qualification/evaluate', { ...calc.selected, taskId: otherTask.taskId })).body.error, 'qualification_calculation_scope_mismatch');
  } finally { await f.close(); }
});

test('external source permissions expire or revoke without granting source text and kept hashes cannot resurrect erased material', async () => {
  const f = await setup({ markedReal: true });
  const { candidate: c, reviewer: r, requester: n } = f;
  try {
    const calc = await f.authorizeCalculation();
    const oldNow = c.access.now;
    c.access.now = () => c.now + 301;
    try { assert.equal((await f.post(n, '/v2/qualification/evaluate', calc.selected)).body.error, 'qualification_calculation_unavailable'); }
    finally { c.access.now = oldNow; }
    const revoke = { id: randomUUID(), kind: 'revoke', grantId: calc.permission.id, reason: 'FICTIONAL revoke this derived disclosure' };
    await f.ok(r, '/v2/qualification/calculation-permissions', await r.authorize(revoke, 'qualification.source-permission', { objectId: revoke.id }));
    assert.equal((await f.post(n, '/v2/qualification/evaluate', calc.selected)).body.error, 'qualification_calculation_unavailable');
    assert.equal((await f.ok(c, '/v2/experience/read', { id: f.attestation.id })).referenceStatus, 'current', 'derived permission revocation does not alter original source permission');
    const next = await f.authorizeCalculation();
    // This exercises the existing retained-row shape, not a claim that the
    // physical subject-deletion executor was invoked by this test.
    await c.db.query("UPDATE experience_events SET payload_text='',context='{}'::jsonb WHERE operation_id=$1", [f.declaration.operationId]);
    const original = await f.ok(c, '/v2/qualification/calculation-receipt', { operationId: next.compute.id, payloadHash: digest(next.signedCompute.payloadJson) });
    assert.equal(original.state, 'acknowledged');
    const erased = await f.ok(n, '/v2/qualification/evaluate', next.selected);
    assert.equal(erased.state, 'insufficient-evidence'); withoutSources(erased, f);
    assert.equal((await c.db.query('SELECT payload_hash FROM experience_events WHERE operation_id=$1', [f.declaration.operationId])).rows[0].payload_hash, digest(f.signedDeclaration.payloadJson));
    assert.equal((await f.post(n, '/v2/experience/read', { id: f.declaration.id })).status, 404);
  } finally { await f.close(); }
});
