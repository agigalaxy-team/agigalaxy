import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { factToolDefinitions } from '../src/personal-mcp-facts-v2.mjs';
import { digest } from '../src/shared/digest.mjs';

// Fictional identities and work. Canonical signatures, database transactions,
// HTTP adapters and ordinary MCP fact consumers execute; no expertise attested.
const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'history', 'evidence'];
async function fixture() {
  const owner = await serviceFixture(scopes);
  let api;
  try {
    const participant = await serviceFixture(scopes, owner.db, { migrateDatabase: false });
    api = createApi({ ...owner, rateLimit: 1000 });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`, requests = [];
    const post = async (who, path, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${who.credential}` }, body: JSON.stringify(body) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const write = async (who, event, viewers = []) => {
      const request = await who.authorize(event, 'case.teaser.publish', { objectId: event.eventId, viewers });
      const receipt = await post(who, '/v2/cases/events', request);
      requests.push({ who, event, request, receipt });
      return { request, receipt };
    };
    const read = (who, root) => post(who, `/v2/cases/${root.caseId}/read`, root.taskId ? { taskId: root.taskId } : {});
    const close = async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await owner.db.close(); };
    return { owner, participant, post, write, read, requests, close };
  } catch (error) {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await owner.db.close(); throw error;
  }
}
function root(who, taskId) {
  const id = randomUUID();
  return { schemaVersion: 2, kind: 'case-created', eventId: id, caseId: id, expectedVersion: 0,
    actorId: who.actor.subjectId, localRef: randomUUID(), title: 'FICTIONAL current facts',
    summary: 'Local test only; no real work or expertise', synthetic: true,
    source: { kind: taskId ? 'active-task' : 'local', reference: taskId ?? randomUUID() }, ...(taskId ? { taskId } : {}) };
}
const fact = (who, r, kind, version, fields) => ({ schemaVersion: 2, kind, eventId: randomUUID(), caseId: r.caseId,
  expectedVersion: version, actorId: who.actor.subjectId, ...(r.taskId ? { taskId: r.taskId } : {}), ...fields });
const diagnosis = (who, r, version, fields = {}) => fact(who, r, 'intervention', version, {
  types: ['diagnosis'], affectsAttemptIds: [], description: 'FICTIONAL diagnosis', sourceRefs: [], observedEffect: 'Only a self-declaration', ...fields });
const result = (who, r, source, version, fields = {}) => fact(who, r, 'result-recorded', version, {
  origin: { kind: 'intervention', id: source.eventId, version: 1 }, scopeVersion: 1, deliverableRefs: [],
  reportedOutcome: 'succeeded', summary: 'FICTIONAL original Result', limitations: 'No real work', supersedes: null, ...fields });
const decision = (who, r, source, version, fields = {}) => fact(who, r, 'resolution-recorded', version, {
  taskScopeVersion: 1, status: 'resolved', summary: 'FICTIONAL decision using Result v1', satisfiedGoals: ['fixture goal'],
  remainingGoals: [], resultRefs: [{ id: source.eventId, version: 1 }], verificationRefs: [], supersedesResolutionId: null, ...fields });
async function taskCase(h) {
  const { owner: o, participant: p } = h, viewers = [p.actor.subjectId];
  const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'diagnosis',
    title: 'FICTIONAL shared work', summary: 'No human acceptance claimed',
    workContext: { goal: 'Bounded diagnosis', currentSituation: 'Local fixture', attemptRefs: [] },
    visibility: 'Private', collaboration: 'open-assistance', enrollmentExpiresAt: o.now + 1000 };
  const ag = (who, event, audience) => who.authorize(event, 'assistance.publish', { objectId: event.operationId ?? event.eventId, viewers: audience });
  await h.post(o, '/v2/tasks', await ag(o, task, viewers));
  const r = root(o, task.taskId), first = diagnosis(o, r, 1);
  const signedRoot = await o.authorize(r, 'case.teaser.publish', { objectId: r.eventId, viewers });
  const signedFirst = await o.authorize(first, 'case.teaser.publish', { objectId: first.eventId, viewers });
  await h.post(o, `/v2/tasks/${task.taskId}/case`, { operationId: randomUUID(), taskId: task.taskId, expectedTaskVersion: 1,
    case: signedRoot, initialFact: signedFirst });
  const proposal = { eventId: randomUUID(), expectedTaskVersion: 1, kind: 'propose', participationId: randomUUID(),
    subjectId: p.actor.subjectId, role: 'review', scopeVersion: 1, agreedScope: 'FICTIONAL bounded review' };
  await h.post(o, `/v2/tasks/${task.taskId}/participations`, await ag(o, proposal, viewers));
  const confirm = { eventId: randomUUID(), expectedParticipationVersion: 1, kind: 'confirm', scopeVersion: 1 };
  await h.post(p, `/v2/participations/${proposal.participationId}/events`, await ag(p, confirm, [o.actor.subjectId]));
  return { r, first, participationId: proposal.participationId };
}
async function assertOriginalBytes(h, erasedIds = []) {
  for (const { event, request } of h.requests) {
    const row = (await h.owner.db.query('SELECT payload_text,payload_hash,case_id,subject_id,kind FROM case_events WHERE id=$1', [event.eventId])).rows[0];
    assert.equal(row.payload_text, erasedIds.includes(event.eventId) ? '' : request.payloadJson);
    assert.equal(row.payload_hash, digest(request.payloadJson));
    assert.equal(row.case_id, event.caseId); assert.equal(row.subject_id, event.actorId); assert.equal(row.kind, event.kind);
  }
}

test('actual HTTP/MCP separate an owner self-response from another active participant confirmation and correction', async () => {
  const h = await fixture();
  const { owner: o, participant: p } = h;
  try {
    const { r, first, participationId } = await taskCase(h);
    const response = (who, version, state, refVersion = 1) => fact(who, r, 'intervention-response', version, {
      interventionRef: { id: first.eventId, version: refVersion }, state, summary: `FICTIONAL ${state}`,
      ...(who === p ? { participationId } : {}) });
    await h.write(o, response(o, 2, 'accepted'), [p.actor.subjectId]);
    let current = (await h.read(o, r)).interventions.at(-1);
    assert.equal(current.responses[0].relationship, 'self');
    assert.equal(current.confirmation, 'unconfirmed');
    await h.write(p, response(p, 3, 'accepted'), [o.actor.subjectId]);
    current = (await h.read(o, r)).interventions.at(-1);
    assert.equal(current.responses.find(a => a.actorId === p.actor.subjectId).relationship, 'participant');
    assert.equal(current.confirmation, 'confirmed');
    await h.write(o, response(o, 4, 'disputed'), [p.actor.subjectId]);
    assert.equal((await h.read(o, r)).interventions.at(-1).confirmation, 'confirmed', 'a self-opinion is preserved without overriding the other actor');
    await h.write(p, response(p, 5, 'partial'), [o.actor.subjectId]);
    assert.equal((await h.read(o, r)).interventions.at(-1).confirmation, 'partially-confirmed');
    await h.write(p, response(p, 6, 'disputed'), [o.actor.subjectId]);
    assert.equal((await h.read(o, r)).interventions.at(-1).confirmation, 'disputed');
    const corrected = diagnosis(o, r, 7, { description: 'FICTIONAL corrected diagnosis', supersedes: { id: first.eventId, version: 1 } });
    await h.write(o, corrected, [p.actor.subjectId]);
    assert.equal((await h.read(o, r)).interventions.at(-1).confirmation, 'unconfirmed', 'old-version opinions never confirm the corrected version');
    await h.write(o, response(o, 8, 'accepted', 2), [p.actor.subjectId]);
    assert.equal((await h.read(o, r)).interventions.at(-1).confirmation, 'unconfirmed');
    await h.write(p, response(p, 9, 'accepted', 2), [o.actor.subjectId]);
    const viaMcp = await factToolDefinitions(o, o.actor).galaxy_case_v2_read.run({ caseId: r.caseId, taskId: r.taskId });
    assert.equal(viaMcp.interventions.at(-1).confirmation, 'confirmed');
    assert.equal(viaMcp.results.length, 0); assert.equal(viaMcp.resolution.status, 'unrecorded');
    assert.equal(viaMcp.interventions.at(-1).capabilityVerified, false);
    await assertOriginalBytes(h);
  } finally { await h.close(); }
});

test('actual HTTP current resolution requires reconfirmation only when its exact Result is corrected; historical decision and event hashes remain', async () => {
  const h = await fixture(), o = h.owner;
  try {
    const r = root(o); await h.write(o, r);
    const source = diagnosis(o, r, 1); await h.write(o, source);
    const original = result(o, r, source, 2); await h.write(o, original);
    const resolved = decision(o, r, original, 3); await h.write(o, resolved);
    const otherSource = diagnosis(o, r, 4); await h.write(o, otherSource);
    const other = result(o, r, otherSource, 5); await h.write(o, other);
    await h.write(o, { ...other, eventId: randomUUID(), expectedVersion: 6, reportedOutcome: 'inconclusive',
      summary: 'Unrelated Result correction', supersedes: { id: other.eventId, version: 1 } });
    assert.equal((await h.read(o, r)).resolution.status, 'resolved', 'unreferenced corrections do not invalidate this decision');
    const revised = { ...original, eventId: randomUUID(), expectedVersion: 7, reportedOutcome: 'inconclusive',
      summary: 'Original evidence was insufficient', supersedes: { id: original.eventId, version: 1 } };
    await h.write(o, revised);
    const view = await h.read(o, r), current = view.resolution;
    assert.equal(current.status, 'unrecorded'); assert.equal(current.priorResolutionId, resolved.eventId);
    assert.equal(current.currentSupport, 'referenced-result-superseded'); assert.equal(current.currentDecisionAvailable, false);
    assert.equal(current.reconfirmationRequired, true); assert.match(current.summary, /重新确认/);
    assert.equal(view.resolutions.length, 1); assert.equal(view.resolutions[0].status, 'resolved');
    assert.deepEqual(view.resolutions[0].resultRefs, [{ id: original.eventId, version: 1 }]);
    assert.deepEqual(view.results.filter(a => a.id === original.eventId).map(a => a.reportedOutcome), ['succeeded', 'inconclusive']);
    const viaMcp = await factToolDefinitions(o, o.actor).galaxy_case_v2_read.run({ caseId: r.caseId });
    assert.deepEqual(viaMcp.resolution, current);
    assert.deepEqual((await o.cases.getV2(o.actor, r.caseId)).resolution, current);
    const history = await h.post(o, '/v2/history/query', { subjectId: o.actor.subjectId });
    const item = history.items.find(a => a.kind === 'case-history' && a.caseId === r.caseId);
    assert.deepEqual(item.resolution, current); assert.equal(item.resolutions[0].status, 'resolved');
    const reconsidered = decision(o, r, original, 8, { status: 'inconclusive', summary: 'Explicit current requester decision',
      resultRefs: [{ id: original.eventId, version: 2 }], supersedesResolutionId: resolved.eventId });
    await h.write(o, reconsidered);
    const final = await h.read(o, r);
    assert.equal(final.resolution.status, 'inconclusive'); assert.equal(final.resolutions.length, 2);
    assert.equal(final.resolutions[0].status, 'resolved');
    await assertOriginalBytes(h);
  } finally { await h.close(); }
});

test('a hidden or revoked newer Result cannot restore older current resolution support or disclose the correction through HTTP/MCP', async () => {
  const h = await fixture(), { owner: o, participant: p } = h;
  try {
    const { r, first, participationId } = await taskCase(h);
    const intervention = diagnosis(p, r, 2, { participationId }); await h.write(p, intervention, [o.actor.subjectId]);
    const original = result(p, r, intervention, 3, { participationId }); await h.write(p, original, [o.actor.subjectId]);
    const resolved = decision(o, r, original, 4); await h.write(o, resolved, [p.actor.subjectId]);
    const unrelated = result(o, r, first, 5); await h.write(o, unrelated, [p.actor.subjectId]);
    await o.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1", [unrelated.eventId]);
    assert.equal((await h.read(o, r)).resolution.status, 'resolved', 'a different author cannot have corrected this participant Result');
    const foreignRoot = root(p); await h.write(p, foreignRoot);
    const foreignSource = diagnosis(p, foreignRoot, 1); await h.write(p, foreignSource);
    const foreignResult = result(p, foreignRoot, foreignSource, 2); await h.write(p, foreignResult);
    let foreignCorrection;
    for (let version = 1; version <= 3; version++) {
      foreignCorrection = { ...foreignResult, eventId: randomUUID(), expectedVersion: version + 2,
        summary: `Unrelated Case correction ${version}`, supersedes: { id: foreignResult.eventId, version } };
      await h.write(p, foreignCorrection);
    }
    await o.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1", [foreignCorrection.eventId]);
    assert.equal((await h.read(o, r)).resolution.status, 'resolved', 'the same author in another Case cannot invalidate this decision');
    const revised = { ...original, eventId: randomUUID(), expectedVersion: 6, reportedOutcome: 'inconclusive',
      summary: 'PRIVATE NEWER CORRECTION TEXT', limitations: 'PRIVATE NEWER LIMITATION TEXT', supersedes: { id: original.eventId, version: 1 } };
    const signed = await h.write(p, revised);
    for (const read of [() => h.read(o, r), () => factToolDefinitions(o, o.actor).galaxy_case_v2_read.run({ caseId: r.caseId, taskId: r.taskId }),
      async () => (await h.post(o, '/v2/history/query', { subjectId: p.actor.subjectId })).items.find(a => a.kind === 'case-history' && a.caseId === r.caseId)]) {
      const view = await read();
      assert.equal(view.resolution.status, 'unrecorded'); assert.equal(view.resolution.currentDecisionAvailable, false);
      assert.equal(view.resolution.currentSupport, 'referenced-result-superseded');
      assert.equal(view.resolutions[0].status, 'resolved'); if (view.coverage) assert.equal(view.coverage.complete, false);
      for (const privateValue of [revised.eventId, revised.summary, revised.limitations]) assert.equal(JSON.stringify(view).includes(privateValue), false);
    }
    await h.post(p, `/v1/consents/${signed.request.consentId}/revoke`, {});
    const after = await h.read(o, r);
    assert.equal(after.resolution.status, 'unrecorded'); assert.equal(after.resolution.currentDecisionAvailable, false);
    assert.equal(after.resolution.currentSupport, 'referenced-result-superseded');
    assert.equal((await h.read(p, r)).resolution.status, 'unrecorded');
    const receipt = await h.post(p, '/v2/cases/events/receipt', { caseId: r.caseId, eventId: revised.eventId, payloadHash: digest(signed.request.payloadJson) });
    assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.currentAccessGranted, false);
    assert.equal(JSON.stringify(receipt).includes(revised.summary), false);
    const erasedIds = [unrelated.eventId, foreignCorrection.eventId];
    await assertOriginalBytes(h, erasedIds);
    // Exact existing retention shape; this is not an M19 executor claim. Once
    // the newer body is gone, its retained kind/actor/version cannot prove that
    // the old supporting Result is still current or expose the erased payload.
    await o.db.query("UPDATE case_events SET payload_text='',payload='{}'::jsonb WHERE id=$1", [revised.eventId]);
    const erased = await h.read(o, r);
    assert.equal(erased.resolution.status, 'unrecorded'); assert.equal(erased.resolution.currentDecisionAvailable, false);
    assert.equal(erased.resolution.currentSupport, 'referenced-result-currentness-unavailable');
    assert.equal(erased.resolutions[0].status, 'resolved');
    for (const privateValue of [revised.eventId, revised.summary, revised.limitations]) assert.equal(JSON.stringify(erased).includes(privateValue), false);
    const retained = (await o.db.query('SELECT payload_text,payload_hash FROM case_events WHERE id=$1', [revised.eventId])).rows[0];
    assert.equal(retained.payload_text, ''); assert.equal(retained.payload_hash, digest(signed.request.payloadJson));
    const reconsidered = decision(o, r, original, 7, { summary: 'Explicitly reconsidered available original Result and retained uncertainty',
      supersedesResolutionId: resolved.eventId });
    const declined = await o.authorize(reconsidered, 'case.teaser.publish', { objectId: reconsidered.eventId, viewers: [p.actor.subjectId] });
    const beforeCount = (await o.db.query('SELECT count(*)::int AS count FROM case_events WHERE case_id=$1', [r.caseId])).rows[0].count;
    await assert.rejects(h.post(o, '/v2/cases/events', declined), error =>
      error.actual === 409 && JSON.parse(error.message.split('\n')[0]).error === 'fact_currentness_unavailable');
    assert.equal((await o.db.query('SELECT version FROM cases WHERE id=$1', [r.caseId])).rows[0].version, 7);
    assert.equal((await o.db.query('SELECT count(*)::int AS count FROM case_events WHERE case_id=$1', [r.caseId])).rows[0].count, beforeCount);
    const declinedReceipt = await h.post(o, '/v2/cases/events/receipt', { caseId: r.caseId, eventId: reconsidered.eventId,
      payloadHash: digest(declined.payloadJson) });
    assert.equal(declinedReceipt.state, 'absent');
    const fresh = result(p, r, intervention, 7, { participationId, summary: 'Explicit new independent Result after retained uncertainty' });
    await h.write(p, fresh, [o.actor.subjectId]);
    const currentDecision = decision(o, r, fresh, 8, { summary: 'Explicit decision about the new exact Result',
      supersedesResolutionId: resolved.eventId });
    await h.write(o, currentDecision, [p.actor.subjectId]);
    const final = await h.read(o, r);
    assert.equal(final.resolution.status, 'resolved'); assert.equal(final.resolution.id, currentDecision.eventId);
    assert.equal(final.resolutions.length, 2); assert.equal(final.resolutions[0].id, resolved.eventId);
    const finalHistory = await h.post(o, '/v2/history/query', { subjectId: p.actor.subjectId });
    assert.equal(finalHistory.items.find(a => a.kind === 'case-history' && a.caseId === r.caseId).resolution.currentDecisionAvailable, true);
    await assertOriginalBytes(h, [...erasedIds, revised.eventId]);
  } finally { await h.close(); }
});
