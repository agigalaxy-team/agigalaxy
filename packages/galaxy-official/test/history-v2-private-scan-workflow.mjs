import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'evidence', 'history', 'data-delete'];
function root(f, title) {
  const id = randomUUID();
  return { schemaVersion: 2, kind: 'case-created', eventId: id, caseId: id, expectedVersion: 0,
    actorId: f.actor.subjectId, localRef: randomUUID(), title, summary: '隔离合成资料，不是实际能力证据',
    synthetic: true, source: { kind: 'local', reference: randomUUID() } };
}
function intervention(f, source, version, text = '独立诊断') {
  return { schemaVersion: 2, kind: 'intervention', eventId: randomUUID(), caseId: source.caseId,
    expectedVersion: version, actorId: f.actor.subjectId, types: ['diagnosis'], affectsAttemptIds: [],
    description: text, sourceRefs: [], observedEffect: '未报告实际修复' };
}
function grant(f, payload, disclosure = {}) {
  return f.authorize(payload, 'case.teaser.publish', { objectId: payload.eventId, ...disclosure });
}
const publicGrant = { visibility: 'Public', purpose: 'public-profile' };
async function publish(f, payload, disclosure) {
  const envelope = await grant(f, payload, disclosure);
  await f.cases.submitV2(f.actor, envelope);
  return envelope;
}
async function fixture(database, options, body) {
  const f = await serviceFixture(scopes, database, { ...options, syntheticCommunityQuota: false });
  const api = createApi({ ...f, rateLimit: 500, searchPageLimit: 500 });
  let measurement = null;
  const original = f.cases.projectAuthorizedWithin.bind(f.cases);
  f.cases.projectAuthorizedWithin = async function (db, actor, parent, rows) {
    if (measurement) {
      measurement.projectedCaseIds.push(parent.id);
      measurement.materializedEvents += rows.length;
      measurement.materializedPayloadBytes += rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload_text ?? ''), 0);
    }
    return original(db, actor, parent, rows);
  };
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + api.address().port + '/v2/history/query';
    const query = async (input, credential) => {
      measurement = { projectedCaseIds: [], materializedEvents: 0, materializedPayloadBytes: 0 };
      const started = performance.now();
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
          ...(credential ? { authorization: 'Bearer ' + credential } : {}) }, body: JSON.stringify(input) });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return { value, ...measurement, durationMs: performance.now() - started };
      } finally { measurement = null; }
    };
    return await body(f, query);
  } finally {
    f.cases.projectAuthorizedWithin = original;
    await new Promise(resolve => api.close(resolve));
    if (!database) await f.db.close();
  }
}

// Caller owns an injected PostgreSQL pool; no production, migrations or DDL are
// required when migrateDatabase:false and the existing restricted API role is used.
export function verifyHistoryPrivateCandidateScan(database = null, options = {}) {
  return fixture(database, options, async (f, query) => {
    for (let index = 0; index < 2; index++) {
      const source = root(f, '公开履历 ' + index);
      await publish(f, source, publicGrant);
      for (let version = 1; version <= 3; version++)
        await publish(f, intervention(f, source, version, '可见诊断' + 'x'.repeat(512)), publicGrant);
    }
    const input = { subjectId: f.actor.subjectId, limit: 1 };
    const baseline = await query(input);
    assert.ok(baseline.value.nextCursor);
    assert.equal(baseline.projectedCaseIds.length, 2);
    const samples = [];
    for (let index = 0; index < 64; index++) {
      const source = root(f, '私有履历 ' + index);
      await publish(f, source);
      for (let version = 1; version <= 3; version++)
        await publish(f, intervention(f, source, version, 'hidden-private-history:' + 'x'.repeat(512)));
      if (index === 15 || index === 63) {
        const current = await query(input);
        assert.deepEqual(current.value, baseline.value);
        assert.equal(current.projectedCaseIds.length, 2);
        assert.equal(current.materializedEvents, 8);
        assert.equal(current.materializedPayloadBytes, baseline.materializedPayloadBytes);
        samples.push({ privateCases: index + 1, projectedCases: current.projectedCaseIds.length,
          materializedEvents: current.materializedEvents, materializedPayloadBytes: current.materializedPayloadBytes,
          durationMs: +current.durationMs.toFixed(3) });
      }
    }
    const next = await query({ ...input, after: baseline.value.nextCursor });
    assert.notEqual(next.value.items[0].caseId, baseline.value.items[0].caseId);
    assert.equal(next.value.nextCursor, null);
    const owner = await query({ subjectId: f.actor.subjectId, limit: 50 }, f.credential);
    assert.equal(owner.projectedCaseIds.length, 66);
    assert.equal(owner.value.items.length, 50);
    assert.ok(owner.value.nextCursor);
    const ownerNext = await query({ subjectId: f.actor.subjectId, limit: 50, after: owner.value.nextCursor }, f.credential);
    assert.equal(ownerNext.value.items.length, 16);
    assert.equal(new Set([...owner.value.items, ...ownerNext.value.items].map(item => item.caseId)).size, 66);
    return { publicResponseAndCursorPreserved: true, ownerCompleteHistoryPreserved: true, samples };
  });
}

export function verifyHistoryCandidateEntrances(database = null, options = {}) {
  return fixture(database, options, async (f, query) => {
    const reader = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false, syntheticCommunityQuota: false });
    const privateRoot = root(f, '指定读者可见根');
    const privateEnvelope = await publish(f, privateRoot, { viewers: [reader.actor.subjectId] });
    const partialRoot = root(f, 'private-root-title-must-stay-hidden');
    await publish(f, partialRoot);
    const publicEvent = intervention(f, partialRoot, 1, '独立公开诊断');
    await publish(f, publicEvent, publicGrant);
    const evidenceRoot = root(f, 'private-evidence-root-must-stay-hidden');
    await publish(f, evidenceRoot);
    const evidence = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, caseId: evidenceRoot.caseId,
      reportedBy: f.actor.subjectId, kind: 'evidence', synthetic: true, evidenceType: 'test-result',
      source: { originSystem: 'synthetic-history-scan', externalStableId: randomUUID(), contentVersion: '1',
        originalAt: new Date(f.now * 1000).toISOString(), issuer: f.actor.subjectId },
      observedAt: new Date(f.now * 1000).toISOString(), reportedSourceState: 'available', summary: '独立公开报告' };
    await f.verificationRecords.submit(f.actor, await f.authorize(evidence, 'evidence.submit',
      { objectId: evidence.operationId, ...publicGrant }));
    const task = { operationId: randomUUID(), taskId: randomUUID(), caseId: null, intent: 'proactive-review',
      title: '指定读者可见任务', summary: 'Case正文与任务原文有独立授权', visibility: 'Private',
      collaboration: 'open-assistance', workContext: { goal: '观察关联', currentSituation: '合成', attemptRefs: [] },
      enrollmentExpiresAt: f.now + 1000 };
    await f.assistance.createTask(f.actor, await f.authorize(task, 'assistance.publish',
      { objectId: task.operationId, viewers: [reader.actor.subjectId] }));
    const taskRoot = { ...root(f, 'private-task-case-title-must-stay-hidden'), taskId: task.taskId,
      source: { kind: 'active-task', reference: task.taskId } };
    const first = { ...intervention(f, taskRoot, 1), taskId: task.taskId };
    await f.cases.createAndLinkTask(f.actor, { operationId: randomUUID(), taskId: task.taskId, expectedTaskVersion: 1,
      case: await grant(f, taskRoot), initialFact: await grant(f, first) });
    const input = { subjectId: f.actor.subjectId, limit: 50 };
    const anonymous = await query(input);
    assert.deepEqual(new Set(anonymous.value.items.map(item => item.caseId)), new Set([partialRoot.caseId, evidenceRoot.caseId]));
    assert.equal(anonymous.value.items.find(item => item.caseId === partialRoot.caseId).title, null);
    assert.equal(anonymous.value.items.find(item => item.caseId === evidenceRoot.caseId).verificationRecords[0].id, evidence.id);
    assert.ok(anonymous.projectedCaseIds.includes(taskRoot.caseId));
    const authorized = await query(input, reader.credential);
    assert.equal(authorized.value.items.length, 4);
    assert.equal(authorized.value.items.find(item => item.caseId === privateRoot.caseId).title, privateRoot.title);
    const linked = authorized.value.items.find(item => item.caseId === taskRoot.caseId);
    assert.equal(linked.title, null);
    assert.equal(linked.collaborations[0].title, task.title);
    const own = await query(input, f.credential);
    assert.equal(own.value.items.length, 4);
    assert.equal(own.projectedCaseIds.length, 4);
    await f.consents.revoke(f.actor, privateEnvelope.consentId);
    const revoked = await query(input, reader.credential);
    assert.equal(revoked.value.items.some(item => item.caseId === privateRoot.caseId), false);
    assert.equal(revoked.projectedCaseIds.includes(privateRoot.caseId), false);
    return { privateReader: true, privateRootPublicEvent: true, independentReport: true, independentTask: true, revocation: true };
  });
}

export function verifyHistoryCandidateDeletionAndExpiry(database = null, options = {}) {
  return fixture(database, options, async (f, query) => {
    const source = root(f, '可取消删除的公开来源');
    const envelope = await publish(f, source, publicGrant);
    const input = { subjectId: f.actor.subjectId };
    const before = await query(input);
    assert.equal(before.value.items.length, 1);
    const request = { version: 1, id: randomUUID(), action: 'request', scope: 'all-owned-service-data',
      reason: 'privacy', takeout: 'not-needed', endpoint: f.access.endpoint, subjectId: f.actor.subjectId,
      bindingId: f.actor.bindingId, issuedAt: f.now, expiresAt: f.now + 300 };
    const receipt = await f.deletion.submit(f.actor, await f.signForTest(JSON.stringify(request), 'galaxy-deletion-intent+jws'));
    const pending = await query(input);
    assert.equal(pending.value.items.length, 0);
    assert.equal(pending.projectedCaseIds.length, 0);
    const own = await query(input, f.credential);
    assert.equal(own.value.items.length, 1);
    const cancel = { version: 1, id: randomUUID(), action: 'cancel', requestId: receipt.id, expectedRevision: 1,
      endpoint: f.access.endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId,
      issuedAt: f.now, expiresAt: f.now + 300 };
    await f.deletion.submit(f.actor, await f.signForTest(JSON.stringify(cancel), 'galaxy-deletion-intent+jws'));
    assert.deepEqual((await query(input)).value, before.value);
    await f.consents.revoke(f.actor, envelope.consentId);
    assert.equal((await query(input)).projectedCaseIds.length, 0);
    const renewed = root(f, '到期授权不进入正文投影');
    await publish(f, renewed, { ...publicGrant, expiresAt: f.now + 1 });
    const originalAccessNow = f.access.now, originalConsentNow = f.consents.now;
    try {
      f.access.now = () => f.now + 2;
      f.consents.now = () => f.now + 2;
      const expired = await query(input);
      assert.equal(expired.value.items.length, 0);
      assert.equal(expired.projectedCaseIds.length, 0);
    } finally {
      f.access.now = originalAccessNow;
      f.consents.now = originalConsentNow;
    }
    await f.bindings.revoke(f.actor.bindingId, f.actor.subjectId, randomUUID(), null, f.actor);
    const unbound = await query(input);
    assert.equal(unbound.value.items.length, 0);
    assert.equal(unbound.projectedCaseIds.length, 0);
    return { pendingDeletionHidden: true, ownerCanonicalViewPreserved: true, cancellationRestores: true,
      grantExpiry: true, bindingRevocation: true };
  });
}

export function verifyHistoryCandidateIsNotAuthority(database = null, options = {}) {
  return fixture(database, options, async (f, query) => {
    const source = root(f, '候选筛选不能授予读取权');
    await publish(f, source, { ...publicGrant, expiresAt: f.now + 1 });
    const accessNow = f.access.now, consentNow = f.consents.now;
    const canonicalCase = f.history.v2.caseWithin.bind(f.history.v2);
    f.history.v2.caseWithin = (...args) => {
      // Explicit isolated clock fault: the metadata gate saw a live grant,
      // but the canonical projection must use its now-expired permission.
      f.access.now = () => f.now + 2;
      f.consents.now = () => f.now + 2;
      return canonicalCase(...args);
    };
    try {
      const result = await query({ subjectId: f.actor.subjectId });
      assert.equal(result.projectedCaseIds.length, 1);
      assert.equal(result.value.items.length, 0);
      assert.equal(JSON.stringify(result.value).includes(source.title), false);
      return { passedCandidateStillRequiresLiveCanonicalGrant: true };
    } finally {
      f.access.now = accessNow;
      f.consents.now = consentNow;
      f.history.v2.caseWithin = canonicalCase;
    }
  });
}
