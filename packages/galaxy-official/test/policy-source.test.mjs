import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { ConsentService } from '../src/consents.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { githubEvidenceSource, inspectGithubRun } from '../src/github-evidence.mjs';

test('extension policy cannot bypass mandatory consent rules; source queues and observation boundaries stay isolated', async () => {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence', 'proof']);
  try {
    const parent = { id: randomUUID(), kind: 'case', localRef: 'case_adapter_fixture', title: 'Adapter fixture', summary: 'Synthetic only',
      source: { kind: 'local', reference: 'case_adapter_fixture' }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const grant = await f.authorize(parent);
    const intent = (await f.db.query('SELECT intent FROM consents WHERE id=$1', [grant.consentId])).rows[0].intent;
    let policyCalled = false;
    const permissive = new ConsentService(f.access, { additionalPolicy: () => { policyCalled = true; return true; } });
    const invalid = { ...intent, id: randomUUID(), fields: [...intent.fields, 'rawContext'] };
    await assert.rejects(permissive.create(f.actor, await f.signForTest(JSON.stringify(invalid), 'galaxy-consent+jws')), /policy_denied/);
    assert.equal(policyCalled, false);
    const denied = { ...intent, id: randomUUID() };
    const restrictive = new ConsentService(f.access, { additionalPolicy: () => false });
    await assert.rejects(restrictive.create(f.actor, await f.signForTest(JSON.stringify(denied), 'galaxy-consent+jws')), /policy_denied/);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM consents WHERE id=$1', [denied.id])).rows[0].count), 0);
    await f.cases.submit(f.actor, grant);
    const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1,
      approach: 'Fixture', configuration: { environment: 'test', version: '1', tools: [] } };
    await f.cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'failed', summary: 'Fixture failure', failureReason: 'Synthetic', limitations: ['Fixture'] };
    await f.cases.submit(f.actor, await f.authorize(result));
    let invalidObservation = true;
    const source = { ...githubEvidenceSource, jobKind: 'verify-fixture', verify(reference, now) {
      const observation = inspectGithubRun(reference, { id: reference.runId, run_attempt: 1, head_sha: reference.commit,
        repository: { full_name: 'fixture/example', private: false, id: 123 }, updated_at: new Date(now * 1000).toISOString(),
        status: 'completed', conclusion: 'failure' }, now);
      return { ...observation, capabilitiesVerified: invalidObservation };
    } };
    const evidence = new EvidenceService(f.access, f.consents, { source });
    const payload = { id: randomUUID(), caseId: parent.id, resultId: result.id,
      source: { provider: 'github-actions', owner: 'fixture', repository: 'example', runId: 1, attempt: 1, commit: 'a'.repeat(40) } };
    await evidence.submit(f.actor, await f.authorize(payload, 'evidence.submit'));
    assert.deepEqual(await f.evidence.processNext(), { processed: false });
    assert.equal((await evidence.processNext()).state, 'unavailable');
    await assert.rejects(f.proofs.preview(f.actor, { id: randomUUID(), evidenceId: payload.id }), /source_unavailable/);
    invalidObservation = false;
    await f.db.query('UPDATE jobs SET available_at=$1 WHERE kind=$2', [new Date(f.now * 1000).toISOString(), source.jobKind]);
    assert.equal((await evidence.processNext()).state, 'observed');
    const observations = (await evidence.get(f.actor, payload.id)).observations;
    assert.equal(observations[0].capabilitiesVerified, false);
    assert.equal(observations[1].status, 'unavailable');
  } finally { await f.db.close(); }
});
