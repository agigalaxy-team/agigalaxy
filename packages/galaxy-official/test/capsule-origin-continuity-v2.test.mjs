import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { digest } from '../src/shared/digest.mjs';
import { capsuleApplicationOriginV2MigrationSql } from '../src/infrastructure/capsule-application-origin-v2-schema.mjs';
import { migrations } from '../src/infrastructure/migrations.mjs';
import { fixture, cg } from './qualification-v2-workflow.mjs';

import { sourceCapsule, ensureOriginSchema, verifyCapsuleOriginContinuity } from './capsule-origin-continuity-v2-workflow.mjs';

test('real HTTP Intervention application, scoped recheck, automatic history and bounded qualification keep the exact original facts',
  () => verifyCapsuleOriginContinuity());


async function targetWork(p, { kind = 'attempt', sourceRefs = [], environment = { name: 'Node', version: '24' } } = {}) {
  const id = randomUUID(), originId = randomUUID(), resultId = randomUUID();
  const root = { schemaVersion: 2, kind: 'case-created', eventId: id, caseId: id, expectedVersion: 0, actorId: p.actor.subjectId,
    localRef: randomUUID(), title: 'Synthetic application', summary: 'Selected new work', source: { kind: 'local', reference: randomUUID() }, synthetic: true };
  const origin = { schemaVersion: 2, kind: kind === 'attempt' ? 'attempt-start' : 'intervention', eventId: originId, caseId: id,
    expectedVersion: 1, actorId: p.actor.subjectId, ...(kind === 'attempt' ? { role: 'implementation', strategy: 'Selected execution',
      inputScopeSummary: 'Selected material', permissionScope: ['selected-material'], environment } : { types: ['diagnosis'],
      affectsAttemptIds: [], description: 'Actual diagnostic contribution', sourceRefs, observedEffect: 'Partial effect' }) };
  const result = { schemaVersion: 2, kind: 'result-recorded', eventId: resultId, caseId: id, expectedVersion: 2,
    actorId: p.actor.subjectId, origin: { kind, id: originId, version: 1 }, scopeVersion: 1, deliverableRefs: [],
    reportedOutcome: 'partial', summary: 'Application only partially helped', limitations: 'Synthetic and self-reported' };
  for (const e of [root, origin, result]) await p.cases.submitV2(p.actor, await cg(p, e));
  return { root, origin, result };
}

function useFor(f, capsule, target, extra = {}) {
  return { schemaVersion: 2, id: randomUUID(), kind: 'apply', capsuleId: capsule.capsuleId, versionId: capsule.id, caseId: target.root.caseId,
    attribution: f.actor.subjectId, note: 'Only selected strategy was used', resultRef: { id: target.result.eventId, version: 1 },
    environment: { name: 'Node', version: '24' }, environmentDifference: 'Different selected material', adoptedParts: ['Compare conditions'], outcome: 'partial', ...extra };
}

test('migration preserves original Attempt bytes and legacy applications; recheck cannot silently substitute a newer Result version', async t => {
  const db = new PGlite(); t.after(() => db.close());
  // Keep the actual previous application constraint while current unrelated
  // source-read tables satisfy the current service contract. Migration 76 is
  // deliberately withheld until the original legacy application is stored.
  for (const migration of migrations.filter(m => m.version !== 76)) await db.exec(migration.sql);
  const { f, p } = await fixture(db, { migrateDatabase: false });
  const capsule = await sourceCapsule(f), target = await targetWork(p);
  const use = useFor(f, capsule, target, { attemptRef: { id: target.origin.eventId, version: 1 } });
  const signed = await p.authorize(use, 'capsule.use');
  await db.query(`INSERT INTO capsule_uses_v2(id,capsule_id,version_id,subject_id,case_id,attempt_id,attempt_version,result_id,result_version,
    prior_use_id,kind,observed_revision,verification_fingerprint,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,1,$7,1,NULL,'apply',1,'',$8,$9,$10)`,
  [use.id, capsule.capsuleId, capsule.id, p.actor.subjectId, target.root.caseId, target.origin.eventId, target.result.eventId,
    signed.consentId, signed.payloadJson, digest(signed.payloadJson)]);
  await db.exec(capsuleApplicationOriginV2MigrationSql);
  const row = (await db.query('SELECT * FROM capsule_uses_v2 WHERE id=$1', [use.id])).rows[0];
  assert.equal(row.origin_kind, 'attempt'); assert.equal(row.origin_id, row.attempt_id); assert.equal(row.origin_version, row.attempt_version);
  assert.equal(row.payload_text, signed.payloadJson); assert.equal(row.payload_hash, digest(signed.payloadJson)); assert.equal(row.consent_id, signed.consentId);
  assert.equal((await f.capsules.usesV2(p.actor, { caseId: target.root.caseId })).items[0].originRef.kind, 'attempt');
  await f.capsules.recordUseV2(p.actor, signed);
  const corrected = { ...target.result, eventId: randomUUID(), expectedVersion: 3, supersedes: { id: target.result.eventId, version: 1 },
    summary: 'Later version of the same Result' };
  await p.cases.submitV2(p.actor, await cg(p, corrected));
  const recheck = { ...use, id: randomUUID(), kind: 'reverify', priorUseId: use.id, resultRef: { id: target.result.eventId, version: 2 },
    verificationRefs: [{ id: randomUUID(), version: 1 }] };
  await assert.rejects(f.capsules.recordUseV2(p.actor, await p.authorize(recheck, 'capsule.use')), { code: 'capsule_application_mismatch' });
  const historic = (await f.capsules.usesV2(p.actor, { caseId: target.root.caseId })).items[0];
  assert.equal(historic.sourceStatus, 'application-result-superseded'); assert.equal(historic.record.resultRef.version, 1);
  const invalid = `UPDATE capsule_uses_v2 SET origin_kind='intervention' WHERE id=$1`;
  await assert.rejects(db.query(invalid, [use.id]), error => error.code === '23514');
  assert.equal((await db.query('SELECT payload_text FROM capsule_uses_v2 WHERE id=$1', [use.id])).rows[0].payload_text, signed.payloadJson);
});

test('Intervention environment comes only from its selected current configuration; missing conditions remain unknown', async t => {
  const { f, p } = await fixture(null, { extraScopes: ['history'] }); t.after(() => f.db.close()); await ensureOriginSchema(f);
  const capsule = await sourceCapsule(f);
  const configuration = { schemaVersion: 2, id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, actorId: p.actor.subjectId,
    kind: 'record', title: 'Selected conditions', summary: 'Explicitly selected synthetic environment', observedAt: new Date(p.now * 1000).toISOString(),
    synthetic: true, selectedFieldsOnly: true, conditions: { model: { name: null, version: null }, runtime: { name: null, version: null },
      environment: { name: 'Linux', version: 'synthetic-1' }, tools: [], skills: [], mcp: [], promptPolicyVersion: null, rulesVersion: null,
      operationScope: ['selected-diagnosis'], inputScopeSummary: null, limitations: 'Not installation verification' } };
  const selected = await p.authorize(configuration, 'configuration.publish', { objectId: configuration.operationId });
  await f.configurations.submit(p.actor, selected);
  const configurationRef = { id: configuration.id, version: 1 };
  const target = await targetWork(p, { kind: 'intervention', sourceRefs: [{ kind: 'configuration', ...configurationRef }] });
  const use = useFor(f, capsule, target, { originRef: { kind: 'intervention', id: target.origin.eventId, version: 1 }, configurationRef,
    environment: { name: 'Linux', version: 'synthetic-1' } });
  const signed = await p.authorize(use, 'capsule.use'); await f.capsules.recordUseV2(p.actor, signed);
  const view = (await f.capsules.usesV2(p.actor, { caseId: target.root.caseId })).items[0];
  assert.equal(view.environmentSource, 'selected-origin-configuration; subject-reported'); assert.equal(view.actualExecutionIndependentlyVerified, false);
  await assert.rejects(f.capsules.recordUseV2(p.actor, await p.authorize({ ...use, id: randomUUID(), configurationRef: { id: randomUUID(), version: 1 } }, 'capsule.use')),
  { code: 'capsule_configuration_not_in_origin' });
  await f.consents.revoke(p.actor, selected.consentId);
  assert.equal((await f.capsules.usesV2(p.actor, { caseId: target.root.caseId })).items[0].record, null);
  assert.equal((await f.capsules.receiptV2(p.actor, { type: 'use', operationId: use.id, payloadHash: digest(signed.payloadJson) })).state, 'acknowledged');
});
