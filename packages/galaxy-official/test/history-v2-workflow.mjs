import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { HistoryV2Service } from "../src/records/history-v2.mjs";

const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'evidence', 'proof', 'history'];
const cg = (f, payload, viewers = [], publicView = false) => f.authorize(payload, 'case.teaser.publish', {
  objectId: payload.eventId, viewers, ...(publicView ? { visibility: 'Public', purpose: 'public-profile' } : {}),
});
const ag = (f, payload, viewers = []) => f.authorize(payload, 'assistance.publish', { objectId: payload.operationId ?? payload.eventId, viewers });
const eg = (f, payload, viewers = []) => f.authorize(payload, 'evidence.submit', { objectId: payload.operationId, viewers });
function history(f) { return new HistoryV2Service(f.access, { cases: f.cases, verificationRecords: f.verificationRecords, assistance: f.assistance, profiles: f.profiles }); }
function root(f, title = '合成履历源') {
  const id = randomUUID(); return { schemaVersion: 2, kind: 'case-created', eventId: id, caseId: id, expectedVersion: 0,
    actorId: f.actor.subjectId, localRef: randomUUID(), title, summary: '仅检查代码行为，非真实试点', synthetic: true,
    source: { kind: 'local', reference: randomUUID() } };
}
function intervention(f, r, version, values = {}) { return { schemaVersion: 2, kind: 'intervention', eventId: randomUUID(),
  caseId: r.caseId, expectedVersion: version, actorId: f.actor.subjectId, types: ['diagnosis'], affectsAttemptIds: [],
  description: '诊断提供了部分范围', sourceRefs: [], observedEffect: '未修复', ...values }; }

export async function verifyHistoryV2Workflow(db, { migrateDatabase = true, repositories, testHttp = false } = {}) {
  const f = await serviceFixture(scopes, db, { migrateDatabase, repositories, syntheticCommunityQuota: false });
  const p = await serviceFixture(scopes, f.db, { migrateDatabase: false, repositories, syntheticCommunityQuota: false });
  const h = history(f), query = who => h.query(f.actor, { subjectId: who.actor.subjectId });
  try {
    assert.deepEqual((await query(p)).items, []);
    assert.match((await query(p)).collaborationEntry, /open-assistance/);
    const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'proactive-review',
      title: '合成多人协作', summary: '没有失败史仍可主动发起并接入新专家', workContext: { goal: '诊断与有限复核', currentSituation: '资料已准备', attemptRefs: [] },
      visibility: 'Private', collaboration: 'open-assistance', capabilityId: 'software-debugging', enrollmentExpiresAt: f.now + 1000 };
    await f.assistance.createTask(f.actor, await ag(f, task, [p.actor.subjectId]));
    let result = await query(f); assert.equal(result.items[0].kind, 'task-history'); assert.equal(result.items[0].workPerformedInferred, false);
    const r = { ...root(f), taskId: task.taskId, source: { kind: 'active-task', reference: task.taskId } };
    const first = intervention(f, r, 1, { taskId: task.taskId });
    await f.cases.createAndLinkTask(f.actor, { operationId: randomUUID(), taskId: task.taskId, expectedTaskVersion: 1,
      case: await cg(f, r, [p.actor.subjectId]), initialFact: await cg(f, first, [p.actor.subjectId]) });
    const proposal = { eventId: randomUUID(), kind: 'propose', expectedTaskVersion: 1, participationId: randomUUID(),
      subjectId: p.actor.subjectId, role: 'patch', scopeVersion: 1, agreedScope: '补丁与自测，生产验收另行进行' };
    await f.assistance.proposeParticipation(f.actor, task.taskId, await ag(f, proposal, [p.actor.subjectId]));
    await f.assistance.submitParticipationEvent(p.actor, proposal.participationId,
      await ag(p, { eventId: randomUUID(), kind: 'confirm', expectedParticipationVersion: 1, scopeVersion: 1 }, [f.actor.subjectId]));
    const pFact = intervention(p, r, 2, { taskId: task.taskId, participationId: proposal.participationId,
      types: ['patch'], description: '已提交有限范围补丁', observedEffect: '需要另一方复核' });
    const pGrant = await cg(p, pFact, [f.actor.subjectId]); await f.cases.submitV2(p.actor, pGrant);
    const outcome = { schemaVersion: 2, kind: 'result-recorded', eventId: randomUUID(), caseId: r.caseId, expectedVersion: 3,
      actorId: p.actor.subjectId, taskId: task.taskId, participationId: proposal.participationId, scopeVersion: 1,
      origin: { kind: 'intervention', id: pFact.eventId, version: 1 }, deliverableRefs: [], reportedOutcome: 'partial',
      summary: '局部修改已提交', limitations: '未执行生产验证' };
    await f.cases.submitV2(p.actor, await cg(p, outcome, [f.actor.subjectId]));
    const delivery = { eventId: randomUUID(), kind: 'deliver', expectedParticipationVersion: 2,
      resultRef: { id: outcome.eventId, version: 1 }, interventionRefs: [{ id: pFact.eventId, version: 1 }], evidenceRefs: [], summary: '补丁敏感交付摘要' };
    await f.assistance.submitParticipationEvent(p.actor, proposal.participationId, await ag(p, delivery, [f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor, proposal.participationId, await ag(f,
      { eventId: randomUUID(), kind: 'accept', expectedParticipationVersion: 3, deliveryId: delivery.eventId, summary: '接收补丁敏感交付摘要' }, [p.actor.subjectId]));
    const base = { caseId: r.caseId, reportedBy: f.actor.subjectId, taskId: task.taskId, expectedVersion: 0, synthetic: true,
      observedAt: new Date(f.now * 1000).toISOString() };
    const evidence = { ...base, id: randomUUID(), operationId: randomUUID(), kind: 'evidence', evidenceType: 'test-result',
      source: { originSystem: 'synthetic-fixture', externalStableId: randomUUID(), contentVersion: '1', issuer: f.actor.subjectId, originalAt: base.observedAt },
      reportedSourceState: 'available', summary: '合成局部测试记录' };
    await f.verificationRecords.submit(f.actor, await eg(f, evidence, [p.actor.subjectId]));
    const verification = { ...base, id: randomUUID(), operationId: randomUUID(), kind: 'verification', scopeVersion: 1,
      target: { type: 'result', id: outcome.eventId, version: 1 }, method: 'unit-test', scope: '仅输入格式', conditions: { environment: 'synthetic' },
      observation: 'passed', summary: '范围内通过', evidenceRefs: [{ id: evidence.id, version: 1 }], relationship: 'independent' };
    await f.verificationRecords.submit(f.actor, await eg(f, verification, [p.actor.subjectId]));
    result = await query(p); const item = result.items.find(i => i.caseId === r.caseId);
    assert.equal(item.attempts.length, 0); assert.ok(item.subjectRoles.includes('patch'));
    assert.deepEqual(new Set(item.interventions.map(i => i.actorId)), new Set([f.actor.subjectId, p.actor.subjectId]));
    assert.equal(item.interventions.find(i => i.actorId === f.actor.subjectId).types[0], 'diagnosis');
    assert.equal(item.results[0].reportedOutcome, 'partial'); assert.equal(item.resolution.status, 'unrecorded');
    assert.equal(item.collaborations[0].participation[0].deliveries[0].acceptance.actorId, f.actor.subjectId);
    assert.equal(item.collaborations[0].participation[0].deliveries[0].verification, 'not-provided');
    assert.equal(item.verificationRecords.find(v => v.id === verification.id).provenance.recordedRelationship, 'requester');
    assert.equal(item.verificationRecords.find(v => v.id === verification.id).provenance.relationshipIndependentlyVerified, false);
    assert.equal(item.capabilityVerified, false);
    assert.equal(JSON.stringify(item).includes('expectedTaskVersion'), false); assert.equal(JSON.stringify(item).includes('caseVersion'), false);
    assert.equal((await h.query(f.actor, { subjectId: p.actor.subjectId, capabilityId: 'software-debugging' })).items.length, 1);
    assert.ok((await query(f)).items[0].subjectRoles.includes('verification-reporter'));
    if (testHttp) {
      const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${api.address().port}/v2/history/query`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credential}` }, body: JSON.stringify({ subjectId: p.actor.subjectId }) });
        assert.equal(response.status, 200); assert.equal((await response.json()).items[0].results[0].reportedOutcome, 'partial');
      } finally { await new Promise(resolve => api.close(resolve)); }
    }
    await f.consents.revoke(p.actor, pGrant.consentId);
    const refreshed = (await query(p)).items[0];
    assert.equal(refreshed.results.length, 0); assert.equal(refreshed.interventions.some(i => i.actorId === p.actor.subjectId), false);
    assert.equal(refreshed.verificationRecords.find(v => v.id === verification.id).referenceStatus, 'dependency-unavailable');
    assert.equal(refreshed.verificationRecords.find(v => v.id === verification.id).record, null);
    assert.equal(JSON.stringify(refreshed).includes('补丁敏感交付摘要'), false);
    assert.equal(refreshed.collaborations[0].participation[0].deliveries[0].resultReferenceStatus, 'unavailable');
    assert.equal(refreshed.interventions[0].actorId, f.actor.subjectId);
    return { multiParty: true, emptyExpertCanParticipate: true, noInventedAttempts: true, revokedSourcePropagation: true };
  } finally { if (!db) await f.db.close(); }
}

export async function verifyHistoryV2Cursor() {
  const f = await serviceFixture(scopes), h = history(f); try {
    const roots = [];
    for (let i = 0; i < 3; i++) {
      const r = root(f, `public ${i}`); roots.push(r);
      await f.cases.submitV2(f.actor, await cg(f, r, [], true));
      const d = intervention(f, r, 1); await f.cases.submitV2(f.actor, await cg(f, d, [], true));
    }
    const input = { subjectId: f.actor.subjectId, limit: 1 };
    const page = await h.query(null, input); assert.ok(page.nextCursor);
    const hidden = root(f, 'never-visible-secret'); await f.cases.submitV2(f.actor, await cg(f, hidden));
    await f.cases.submitV2(f.actor, await cg(f, intervention(f, roots[0], 2, { description: 'hidden-event-secret' })));
    const repeated = await h.query(null, input); assert.equal(page.nextCursor, repeated.nextCursor);
    assert.equal(JSON.stringify(repeated).includes('hidden-event-secret'), false);
    const second = await h.query(null, { ...input, after: page.nextCursor }); assert.notEqual(second.items[0].key, page.items[0].key);
    await assert.rejects(h.query(f.actor, { ...input, after: page.nextCursor }), /invalid_history_cursor/);
    const publicCorrection = intervention(f, roots[0], 3, { description: 'new-public-diagnosis' });
    const grant = await cg(f, publicCorrection, [], true); await f.cases.submitV2(f.actor, grant);
    await assert.rejects(h.query(null, { ...input, after: page.nextCursor }), /history_sources_changed_retry/);
    const changed = await h.query(null, input);
    await f.consents.revoke(f.actor, grant.consentId);
    await assert.rejects(h.query(null, { ...input, after: changed.nextCursor }), /history_sources_changed_retry/);
    assert.equal((await h.query(null, { subjectId: f.actor.subjectId, timeWindow: { kind: '90-days' } })).items.length, 0);
    assert.equal((await h.query(null, { subjectId: f.actor.subjectId, timeWindow: { kind: 'custom', from: '2000-01-01T00:00:00Z', before: '2040-01-01T00:00:00Z' } })).items.length, 3);
    const firstProfile = { id: randomUUID(), expectedRevision: 0, selfDeclared: { about: 'not-a-verified-capability' } };
    await f.profiles.publish(f.actor, await f.authorize(firstProfile, 'profile.publish', { visibility: 'Public', purpose: 'public-profile' }));
    const old = await h.query(null, input); assert.equal(old.selfDeclared.about, 'not-a-verified-capability');
    const replacement = { id: randomUUID(), expectedRevision: 1, selfDeclared: { about: 'private-replacement' } };
    await f.profiles.publish(f.actor, await f.authorize(replacement, 'profile.publish'));
    assert.deepEqual((await h.query(null, input)).selfDeclared, {});
    await assert.rejects(h.query(null, { ...input, after: old.nextCursor }), /history_sources_changed_retry/);
  } finally { await f.db.close(); }
}

export async function verifyHistoryV2BoundReferences() {
  const f = await serviceFixture(scopes), h = history(f); try {
    const r = root(f); await f.cases.submitV2(f.actor, await cg(f, r, [], true));
    const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: randomUUID(), caseId: r.caseId,
      expectedVersion: 1, actorId: f.actor.subjectId, role: 'diagnosis', strategy: '实际尝试有限输入',
      permissionScope: ['read-selected-context'], inputScopeSummary: '合成选择片段', startedAt: new Date(f.now * 1000).toISOString() };
    const grant = await cg(f, attempt, [], true); await f.cases.submitV2(f.actor, grant);
    const interventionEvent = intervention(f, r, 2, { affectsAttemptIds: [attempt.eventId] });
    await f.cases.submitV2(f.actor, await cg(f, interventionEvent, [], true));
    const before = await h.query(null, { subjectId: f.actor.subjectId });
    assert.deepEqual(before.items[0].interventions[0].affectsAttemptRefs, [{ id: attempt.eventId, version: 1 }]);
    await f.cases.submitV2(f.actor, await cg(f, { schemaVersion: 2, kind: 'attempt-end', eventId: randomUUID(), caseId: r.caseId,
      expectedVersion: 3, actorId: f.actor.subjectId, attemptRef: { id: attempt.eventId, version: 1 }, status: 'canceled',
      summary: 'private-ending-must-not-retarget-an-old-public-intervention', failureReason: 'unknown' }));
    const after = await h.query(null, { subjectId: f.actor.subjectId });
    assert.equal(before.rebuild.sourceHash, after.rebuild.sourceHash);
    assert.equal((await h.query(f.actor, { subjectId: f.actor.subjectId, timeWindow: { kind: '90-days' } })).items.length, 1);
    await f.consents.revoke(f.actor, grant.consentId);
    assert.equal((await h.query(null, { subjectId: f.actor.subjectId })).items[0].interventions.length, 0);
  } finally { await f.db.close(); }
}

export async function verifyHistoryV2AllPages() {
  const f = await serviceFixture(scopes), h = history(f); try {
    for (let i = 0; i < 201; i++) { const r = root(f, `超过旧200候选截断 ${i}`); await f.cases.submitV2(f.actor, await cg(f, r, [], true)); }
    const seen = new Set(); let after = null;
    do {
      const page = await h.query(null, { subjectId: f.actor.subjectId, limit: 50, after });
      for (const item of page.items) { assert.equal(seen.has(item.caseId), false); seen.add(item.caseId); }
      assert.equal(page.globalCountProvided, false); after = page.nextCursor;
    } while (after);
    assert.equal(seen.size, 201);
  } finally { await f.db.close(); }
}
