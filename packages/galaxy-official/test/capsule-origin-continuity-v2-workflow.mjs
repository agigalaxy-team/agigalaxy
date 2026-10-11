import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from '../src/http.mjs';
import { digest } from '../src/shared/digest.mjs';
import { capsuleUseV2Schema } from '../src/shared/capsule-v2-schema.mjs';
import { capsuleApplicationOriginV2MigrationSql } from '../src/infrastructure/capsule-application-origin-v2-schema.mjs';
import { fixture, nativeWork, task, ag, cg } from './qualification-v2-workflow.mjs';

export async function sourceCapsule(f) {
  const id = randomUUID(), attemptId = randomUUID(), resultId = randomUUID();
  const root = { schemaVersion: 2, kind: 'case-created', eventId: id, caseId: id, expectedVersion: 0,
    actorId: f.actor.subjectId, localRef: randomUUID(), title: 'Synthetic source', summary: 'No real customer acceptance',
    source: { kind: 'local', reference: randomUUID() }, synthetic: true };
  const attempt = { schemaVersion: 2, kind: 'attempt-start', eventId: attemptId, caseId: id, expectedVersion: 1,
    actorId: f.actor.subjectId, role: 'implementation', strategy: 'Selected synthetic check', inputScopeSummary: 'Synthetic material',
    permissionScope: ['selected-material'], environment: { name: 'Node', version: '24' } };
  const result = { schemaVersion: 2, kind: 'result-recorded', eventId: resultId, caseId: id, expectedVersion: 2,
    actorId: f.actor.subjectId, origin: { kind: 'attempt', id: attemptId, version: 1 }, scopeVersion: 1,
    deliverableRefs: [], reportedOutcome: 'succeeded', summary: 'Source check reported success', limitations: 'Synthetic only' };
  for (const e of [root, attempt, result]) await f.cases.submitV2(f.actor, await cg(f, e));
  const v = { schemaVersion: 2, id: randomUUID(), capsuleId: randomUUID(), kind: 'version', expectedRevision: 0, version: 1,
    publicationClass: 'formal-source-success', synthetic: true, title: 'Selected diagnostic method', problemPattern: 'Scope difference',
    environment: { name: 'Node', version: '24' }, solutionStrategy: 'Compare selected conditions', tools: [], skills: [], mcpRefs: [],
    verificationMethod: 'Scoped observations', limitations: ['Synthetic source'], capabilityId: 'software-debugging',
    applicableScope: 'Selected diagnosis', license: 'MIT', contributors: [], sourceResolution: { caseId: id, resultId, resultVersion: 1 },
    sourceRefs: [], permissionRefs: [], attributionRefs: [], externalReferences: [], redactionConfirmed: true };
  await f.capsules.publishV2(f.actor, await f.authorize(v, 'capsule.publish', { visibility: 'Public', purpose: 'public-profile' }));
  return v;
}

export async function ensureOriginSchema(f) {
  const exists = (await f.db.query("SELECT 1 FROM information_schema.columns WHERE table_name='capsule_uses_v2' AND column_name='origin_kind'")).rows.length;
  if (!exists) await f.db.exec(capsuleApplicationOriginV2MigrationSql);
}

export async function verifyCapsuleOriginContinuity(database = null, options = {}) {
  const { f, p } = await fixture(database, { ...options, extraScopes: [...new Set(['history', ...(options.extraScopes ?? [])])] });
  let api;
  try {
  await ensureOriginSchema(f);
  const capsule = await sourceCapsule(f), work = await nativeWork(f, p);
  assert.equal(Number((await f.db.query("SELECT count(*) FROM case_events WHERE case_id=$1 AND kind='attempt-start'", [work.cid])).rows[0].count), 0);
  api = createApi({ ...f, rateLimit: 500 }); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const request = async (path, who, input, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${api.address().port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + who.credential }, body: JSON.stringify(input) });
    const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
  };
  const use = { schemaVersion: 2, id: randomUUID(), kind: 'apply', capsuleId: capsule.capsuleId, versionId: capsule.id,
    caseId: work.cid, taskId: work.open.taskId, participationId: work.proposal.participationId, attribution: f.actor.subjectId,
    note: 'Only selected diagnostic strategy was applied', originRef: { kind: 'intervention', id: work.intervention.eventId, version: 1 },
    resultRef: { id: work.result.eventId, version: 1 }, environment: { name: 'unknown', version: 'unknown' },
    environmentDifference: 'Intervention has no recorded environment; compatibility unknown', adoptedParts: ['Compare selected conditions'], outcome: 'partial' };
  const signed = await p.authorize(use, 'capsule.use', { viewers: [f.actor.subjectId] });
  const committed = await request('/v2/capsules/uses', p, signed);
  assert.deepEqual(await request('/v2/capsules/uses', p, signed), committed, 'same operation has a consistent minimal ACK');
  const receipt = await request('/v2/capsules/receipt', p, { type: 'use', operationId: use.id, payloadHash: digest(signed.payloadJson) });
  assert.equal(receipt.state, 'acknowledged'); assert.equal(receipt.currentReadPermissionConfirmed, false);
  const stored = (await f.db.query('SELECT attempt_id,attempt_version,origin_kind,origin_id,origin_version,payload_text FROM capsule_uses_v2 WHERE id=$1', [use.id])).rows[0];
  assert.equal(stored.attempt_id, null); assert.equal(stored.attempt_version, null); assert.equal(stored.origin_kind, 'intervention');
  assert.equal(stored.origin_id, work.intervention.eventId); assert.equal(stored.origin_version, 1); assert.equal(stored.payload_text, signed.payloadJson);
  const bounded = task(f, true); await f.assistance.createTask(f.actor, await ag(f, bounded, [p.actor.subjectId]));
  const evaluated = await request('/v2/qualification/evaluate', p, { taskId: bounded.taskId, subjectId: p.actor.subjectId,
    evidence: { capsuleUseIds: [use.id] }, includeSimulation: true });
  assert.equal(evaluated.state, 'insufficient-evidence'); assert.equal(evaluated.capabilityVerified, false);
  assert.equal(evaluated.observations.find(o => o.id === use.id).state, 'actual-application-requires-scoped-review');
  const base = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, caseId: work.cid, reportedBy: p.actor.subjectId,
    taskId: work.open.taskId, participationId: work.proposal.participationId, participationScopeVersion: 1,
    synthetic: true, observedAt: new Date(p.now * 1000).toISOString() };
  const evidence = { ...base, kind: 'evidence', evidenceType: 'test-result', source: { originSystem: 'synthetic-review', externalStableId: randomUUID(),
    contentVersion: '1', issuer: p.actor.subjectId, originalAt: base.observedAt }, reportedSourceState: 'available', summary: 'Scoped check found partial effect' };
  await f.verificationRecords.submit(p.actor, await p.authorize(evidence, 'evidence.submit', { objectId: evidence.operationId }));
  const verification = { ...base, id: randomUUID(), operationId: randomUUID(), kind: 'verification', target: { type: 'result', ...use.resultRef },
    scopeVersion: 1, method: 'local-test', scope: 'Only selected diagnosis', conditions: { environment: 'unknown' }, observation: 'inconclusive',
    evidenceRefs: [{ id: evidence.id, version: 1 }], relationship: 'same-controller', summary: 'Check is separate from acceptance and resolution' };
  await f.verificationRecords.submit(p.actor, await p.authorize(verification, 'evidence.submit', { objectId: verification.operationId }));
  const recheck = { ...use, id: randomUUID(), kind: 'reverify', priorUseId: use.id, verificationRefs: [{ id: verification.id, version: 1 }] };
  await request('/v2/capsules/uses', p, await p.authorize(recheck, 'capsule.use'));
  const history = await request('/v2/history/query', p, { subjectId: p.actor.subjectId });
  const item = history.items.find(i => i.caseId === work.cid), applied = item.capsuleReuse.items.find(i => i.eventId === use.id);
  assert.equal(applied.originRef.kind, 'intervention'); assert.equal(applied.record.outcome, 'partial');
  assert.equal(applied.environmentSource, 'unknown-origin-conditions'); assert.ok(item.subjectRoles.includes('capsule-applicant'));
  assert.equal(item.resolution.status, 'unrecorded'); assert.equal(applied.verifiedReuse, false); assert.equal(item.capabilityVerified, false);
  const wrongEnvironment = await p.authorize({ ...use, id: randomUUID(), environment: capsule.environment }, 'capsule.use');
  assert.equal((await request('/v2/capsules/uses', p, wrongEnvironment, 409)).error, 'capsule_environment_mismatch');
  assert.equal(capsuleUseV2Schema.safeParse({ ...use, attemptRef: { id: work.intervention.eventId, version: 1 } }).success, false);
  const other = await f.authorize({ ...use, id: randomUUID() }, 'capsule.use');
  assert.equal((await request('/v2/capsules/uses', f, other, 403)).error, 'capsule_application_author_required');
  const revisedScope = { eventId: randomUUID(), kind: 'propose-scope', expectedParticipationVersion: 4, scopeVersion: 2,
    agreedScope: 'A different selected scope', reason: 'Do not assign old results to new agreement' };
  await f.assistance.submitParticipationEvent(f.actor, work.proposal.participationId, await ag(f, revisedScope, [p.actor.subjectId]));
  await f.assistance.submitParticipationEvent(p.actor, work.proposal.participationId, await ag(p,
    { eventId: randomUUID(), kind: 'confirm-scope', expectedParticipationVersion: 5, proposalId: revisedScope.eventId }, [f.actor.subjectId]));
  assert.equal((await request('/v2/capsules/uses', p, await p.authorize({ ...use, id: randomUUID() }, 'capsule.use'), 403)).error,
    'capsule_application_scope_changed');
  assert.equal((await request('/v2/capsules/uses/query', p, { caseId: work.cid })).items.find(i => i.eventId === use.id).record.resultRef.version, 1,
    'current scope change does not rewrite previously recorded application');
  const originalConsent = (await f.db.query('SELECT consent_id FROM case_events WHERE id=$1', [work.intervention.eventId])).rows[0].consent_id;
  await f.consents.revoke(p.actor, originalConsent);
  const withdrawn = await request('/v2/capsules/uses/query', p, { caseId: work.cid });
  assert.equal(withdrawn.items.find(i => i.eventId === use.id).record, null);
  assert.equal((await request('/v2/capsules/receipt', p, { type: 'use', operationId: use.id, payloadHash: digest(signed.payloadJson) })).state, 'acknowledged');
  assert.equal((await request('/v2/qualification/evaluate', p, { taskId: bounded.taskId, subjectId: p.actor.subjectId,
    evidence: { capsuleUseIds: [use.id] } })).observations.find(o => o.id === use.id).state, 'unavailable');
  assert.equal(Number((await f.db.query("SELECT count(*) FROM case_events WHERE case_id=$1 AND kind='attempt-start'", [work.cid])).rows[0].count), 0);
  return { syntheticOnly: true, actualHttp: true, interventionWithoutAttempt: true, exactOriginalReceipt: true,
    automaticHistory: true, automaticQualification: false, revokedSourceWithheld: true };
  } finally {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    if (!database) await f.db.close();
  }
}
