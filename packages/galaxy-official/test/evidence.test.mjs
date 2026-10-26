import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { CaseService } from "../src/cases/index.mjs";
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { inspectGithubRun, githubSourceKey } from "../src/evidence/github-evidence.mjs";
import { verifyEnvelope } from "../src/security/signed-envelope.mjs";
import { createApi } from '../src/http.mjs';

test('CI observation stays limited, source duplicates collapse and queued revocation blocks collection', async () => {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'history']);
  let api;
  try {
    const cases = new CaseService(f.access, f.consents);
    const evidence = new EvidenceService(f.access, f.consents);
    let workerNow = f.now;
    const worker = new EvidenceService(null, new ConsentReader({ now: () => workerNow }),
      { db: f.db, endpoint: f.bindings.endpoint, now: () => workerNow });
    const proofs = f.proofs;
    api = createApi({ ...f, evidence, proofs });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`;
    const parent = { id: randomUUID(), kind: 'case', localRef: 'synthetic-evidence', title: 'Synthetic only', summary: 'Not a real case',
      source: { kind: 'local', reference: 'synthetic-evidence' }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    await cases.submit(f.actor, await f.authorize(parent));
    const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1, approach: 'Fixture',
      configuration: { environment: 'test', version: '1', tools: [] } };
    await cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'succeeded', summary: 'Claimed by fixture', failureReason: '', limitations: ['Synthetic'] };
    await cases.submit(f.actor, await f.authorize(result));
    const payload = { id: randomUUID(), caseId: parent.id, resultId: result.id, source: {
      provider: 'github-actions', owner: 'fixture', repository: 'example', runId: 1, attempt: 1, commit: 'a'.repeat(40) } };
    const authorized = await f.authorize(payload, 'evidence.submit');
    await f.db.query("ALTER TABLE audit_events ADD CONSTRAINT synthetic_submit_failure CHECK (action <> 'evidence.submit')");
    await assert.rejects(evidence.submit(f.actor, authorized), /synthetic_submit_failure/);
    assert.equal((await f.db.query('SELECT * FROM evidence_submissions')).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM jobs')).rows.length, 0);
    await f.db.query('ALTER TABLE audit_events DROP CONSTRAINT synthetic_submit_failure');
    const submittedHttp = await fetch(`${origin}/v1/evidence-submissions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credential}` }, body: JSON.stringify(authorized) });
    assert.equal(submittedHttp.status, 202); await submittedHttp.arrayBuffer();
    await assert.rejects(proofs.preview(f.actor, { id: randomUUID(), evidenceId: payload.id }), /source_unavailable/);
    await evidence.submit(f.actor, authorized);
    assert.equal((await f.db.query("SELECT * FROM jobs WHERE kind='verify-github'")).rows.length, 1);
    const submitAudit = (await f.db.query("SELECT * FROM audit_events WHERE action='evidence.submit' AND object_id=$1", [payload.id])).rows;
    assert.equal(submitAudit.length, 1);
    assert.equal(submitAudit[0].consent_id, authorized.consentId);
    assert.equal(submitAudit[0].scope, 'evidence');
    assert.equal(submitAudit[0].http_request_id, submittedHttp.headers.get('x-request-id'));
    assert.equal(submitAudit[0].idempotency_key, payload.id);
    assert.deepEqual(submitAudit[0].credential_scopes, f.actor.scopes);
    assert.equal(submitAudit[0].caller_binding_id, f.actor.bindingId);
    assert.ok(!JSON.stringify(submitAudit).includes(f.credential));
    assert.ok(!JSON.stringify(submitAudit).includes(f.actor.credentialHash));
    await assert.rejects(evidence.submit(f.actor, await f.authorize({ ...payload, id: randomUUID() }, 'evidence.submit')), /conflict/);
    const run = { id: 1, run_attempt: 1, head_sha: payload.source.commit, repository: { full_name: 'fixture/example', private: false, id: 123 },
      updated_at: new Date(f.now * 1000).toISOString(), status: 'completed', conclusion: 'success',
      rawLog: 'SYNTHETIC-SOURCE-LOG-NOT-FOR-PERSISTENCE', artifacts: [{ content: 'SYNTHETIC-SOURCE-ARTIFACT-NOT-FOR-PERSISTENCE' }] };
    assert.throws(() => inspectGithubRun(payload.source, { ...run, head_sha: 'b'.repeat(40) }, f.now));
    assert.throws(() => githubSourceKey({ ...payload.source, repository: '../private' }));
    await worker.processNext((source, now) => inspectGithubRun(source, run, now));
    const observed = await evidence.get(f.actor, payload.id);
    assert.equal(observed.state, 'observed'); assert.equal(observed.capabilityVerified, false);
    assert.equal(observed.observations[0].independence, 'repository-controlled');
    const storedObservation = (await f.db.query('SELECT observation FROM verification_attempts WHERE evidence_id=$1', [payload.id])).rows[0].observation;
    assert.deepEqual(storedObservation, observed.observations[0]);
    assert.ok(!JSON.stringify(storedObservation).includes('NOT-FOR-PERSISTENCE'));
    assert.match(storedObservation.responseHash, /^[a-f0-9]{64}$/);
    const preview = await proofs.preview(f.actor, { id: randomUUID(), evidenceId: payload.id });
    const proofRequest = await f.authorize(JSON.parse(preview.payloadJson), 'proof.publish');
    const issued = await proofs.publish(f.actor, proofRequest);
    assert.deepEqual(await proofs.publish(f.actor, proofRequest), issued);
    const verified = await verifyEnvelope(issued.signed, { type: 'proof', issuer: f.bindings.endpoint,
      audience: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys, now: f.now, maxAge: 86400 });
    assert.equal(verified.data.capabilityVerified, false);
    assert.equal(verified.data.taskOutcomeVerification, 'not-independently-verified');
    assert.equal((await proofs.get(f.actor, issued.proofId)).status, 'active');
    await assert.rejects(proofs.get(null, issued.proofId), /not_found/);
    assert.equal((await fetch(`${origin}/v1/proofs/${issued.proofId}`)).status, 404);
    await assert.rejects(proofs.publish(f.actor, { ...proofRequest,
      payloadJson: JSON.stringify({ ...JSON.parse(proofRequest.payloadJson), capabilityVerified: true }) }), /preview_changed/);
    const publicPreview = await proofs.preview(f.actor, { id: randomUUID(), evidenceId: payload.id });
    const publicRequest = await f.authorize(JSON.parse(publicPreview.payloadJson), 'proof.publish', { visibility: 'Public', purpose: 'public-profile' });
    const publicProof = await proofs.publish(f.actor, publicRequest);
    assert.equal((await proofs.get(null, publicProof.proofId)).status, 'active');
    const reviewId = randomUUID();
    const review = { kind: 'revision', id: reviewId, caseId: parent.id, expectedVersion: 3,
      correctsEventId: result.id, reason: 'Question task outcome', summary: 'CI did not establish task success',
      review: { threadId: reviewId, type: 'dispute', state: 'opened' } };
    await cases.submit(f.actor, await f.authorize(review));
    const disputed = await proofs.get(f.actor, publicProof.proofId);
    assert.equal(disputed.caseContext.status, 'active-dispute');
    assert.equal(disputed.signed, publicProof.signed, 'Case disputes do not rewrite the signed CI fact');
    assert.equal(disputed.caseContext.independentDecision, false);
    assert.equal((await proofs.get(null, publicProof.proofId)).caseContext, undefined, 'Private case context is not leaked through public Proof');
    assert.equal((await proofs.get(f.actor, publicProof.proofId, true)).caseContext.status, 'active-dispute');
    const projected = await f.history.query(f.actor, { subjectId: f.actor.subjectId });
    assert.ok(projected.items[0].proofs.every(proof => proof.caseContext.status === 'active-dispute'));
    await cases.submit(f.actor, await f.authorize({ ...review, id: randomUUID(), expectedVersion: 4,
      review: { ...review.review, state: 'resolved' }, summary: 'Owner clarified the limitation' }));
    assert.equal((await proofs.get(f.actor, publicProof.proofId)).caseContext.status, 'review-recorded');
    await cases.submit(f.actor, await f.authorize({ kind: 'revision', id: randomUUID(), caseId: parent.id,
      expectedVersion: 5, correctsEventId: result.id, reason: 'Clarification', summary: 'Task success remains unverified' }));
    assert.equal((await proofs.get(f.actor, publicProof.proofId)).caseContext.status, 'has-corrections');
    assert.equal((await f.history.query(f.actor, { subjectId: f.actor.subjectId })).items[0].proofs.length, 2);
    assert.equal((await fetch(`${origin}/v1/proofs/${publicProof.proofId}/status`)).status, 200);
    const revokeResponse = await fetch(`${origin}/v1/proofs/${issued.proofId}/revoke`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credential}` }, body: '{}' });
    assert.equal(revokeResponse.status, 200);
    await proofs.revoke(f.actor, issued.proofId);
    const proofAudit = (await f.db.query("SELECT * FROM audit_events WHERE object_id=$1 AND action IN ('proof.publish','proof.revoke') ORDER BY action", [issued.proofId])).rows;
    assert.equal(proofAudit.length, 2);
    for (const entry of proofAudit) {
      assert.equal(entry.context_version, 1);
      assert.equal(entry.scope, 'proof');
      assert.equal(entry.caller_binding_id, f.actor.bindingId);
      assert.deepEqual(entry.credential_scopes, f.actor.scopes);
      assert.deepEqual(entry.binding_scopes, f.actor.scopes);
      assert.equal(entry.consent_id, proofRequest.consentId);
      assert.equal(entry.binding_id, f.actor.bindingId);
      assert.equal(entry.audience, f.bindings.endpoint);
      assert.match(entry.client_id, /^[0-9a-f-]{36}$/);
      assert.equal(entry.idempotency_key, issued.proofId);
    }
    assert.equal(proofAudit[0].http_request_id, null);
    assert.equal(proofAudit[1].http_request_id, revokeResponse.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(proofAudit).includes(f.credential));

    await assert.rejects(proofs.get(f.actor, issued.proofId), /not_found/);
    const queued = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 2 } };
    const queuedAuth = await f.authorize(queued, 'evidence.submit');
    await evidence.submit(f.actor, queuedAuth); await f.consents.revoke(f.actor, queuedAuth.consentId);
    let fetched = false;
    assert.equal((await worker.processNext(() => { fetched = true; throw new Error(); })).state, 'revoked');
    assert.equal(fetched, false);
    const racing = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 3 } };
    const racingAuth = await f.authorize(racing, 'evidence.submit');
    await evidence.submit(f.actor, racingAuth);
    assert.equal((await worker.processNext(async (source, now) => {
      await f.consents.revoke(f.actor, racingAuth.consentId);
      return inspectGithubRun(source, { ...run, id: 3 }, now);
    })).state, 'revoked');
    await assert.rejects(evidence.get(f.actor, racing.id), /consent_required/);
    await f.consents.revoke(f.actor, authorized.consentId);
    await assert.rejects(proofs.get(null, publicProof.proofId), /not_found/);
    assert.equal((await f.history.query(f.actor, { subjectId: f.actor.subjectId })).items[0].proofs.length, 0);
    assert.equal((await fetch(`${origin}/v1/proofs/${publicProof.proofId}`)).status, 404);
    const failing = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 4 } };
    const failingAuth = await f.authorize(failing, 'evidence.submit');
    await evidence.submit(f.actor, failingAuth);
    let fetches = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const processed = await worker.processNext(source => {
        fetches++;
        if (attempt === 3) return inspectGithubRun(source, { ...run, id: 4, head_sha: 'b'.repeat(40) }, workerNow);
        throw new Error('synthetic private upstream diagnostic');
      });
      assert.equal(processed.state, 'unavailable');
      const job = (await f.db.query("SELECT state, attempts FROM jobs WHERE payload->>'evidenceId'=$1", [failing.id])).rows[0];
      assert.equal(job.attempts, attempt); assert.equal(job.state, attempt === 5 ? 'failed' : 'pending');
      assert.equal((await worker.processNext(() => { throw new Error('Retry occurred before due time'); })).processed, false);
      workerNow += 300;
    }
    assert.equal(fetches, 5);
    const unavailable = await evidence.get(f.actor, failing.id);
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.observations.length, 5);
    const workerAudit = (await f.db.query("SELECT * FROM audit_events WHERE action='evidence.observe' AND object_id=$1 ORDER BY sequence", [failing.id])).rows;
    assert.equal(workerAudit.length, 5);
    assert.equal(new Set(workerAudit.map(entry => entry.idempotency_key)).size, 5);
    for (const [index, entry] of workerAudit.entries()) {
      assert.equal(entry.context_version, 1);
      assert.equal(entry.client_id, 'galaxy-evidence-worker');
      assert.equal(entry.audience, f.bindings.endpoint);
      assert.equal(entry.scope, 'evidence');
      assert.equal(entry.credential_scopes, null, 'worker has no user session');
      assert.equal(entry.caller_binding_id, null);
      assert.equal(entry.caller_client_id, null);
      assert.deepEqual(entry.binding_scopes, f.actor.scopes);
      assert.equal(entry.binding_id, f.actor.bindingId);
      assert.match(entry.consent_id, /^[0-9a-f-]{36}$/);
      assert.equal(entry.http_request_id, null);
      assert.equal(entry.idempotency_key, `${entry.request_id}:${index + 1}`);
      assert.equal(entry.outcome, 'unavailable');
    }
    assert.ok(!JSON.stringify(workerAudit).includes(f.credential));

    assert.equal(JSON.stringify(unavailable).includes('private upstream'), false);
    await assert.rejects(proofs.preview(f.actor, { id: randomUUID(), evidenceId: failing.id }), /source_unavailable/);
    const retryRevoked = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 5 } };
    const retryAuth = await f.authorize(retryRevoked, 'evidence.submit');
    await evidence.submit(f.actor, retryAuth);
    assert.equal((await worker.processNext(() => { throw new Error('temporary failure'); })).state, 'unavailable');
    await f.consents.revoke(f.actor, retryAuth.consentId); workerNow += 300;
    let retried = false;
    assert.equal((await worker.processNext(() => { retried = true; })).state, 'revoked');
    assert.equal(retried, false);

    const crashed = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 6 } };
    await evidence.submit(f.actor, await f.authorize(crashed, 'evidence.submit'));
    await f.db.query("UPDATE jobs SET state='running',attempts=5,lease_id=$1,locked_until=$2 WHERE payload->>'evidenceId'=$3",
      [randomUUID(), new Date((workerNow - 1) * 1000).toISOString(), crashed.id]);
    await f.db.query("ALTER TABLE audit_events ADD CONSTRAINT synthetic_exhaustion_failure CHECK (action <> 'evidence.unavailable')");
    await assert.rejects(worker.processNext(() => { throw new Error('Exhausted lease must not fetch'); }), /synthetic_exhaustion_failure/);
    assert.equal((await f.db.query("SELECT state FROM jobs WHERE payload->>'evidenceId'=$1", [crashed.id])).rows[0].state, 'running');
    assert.equal((await f.db.query('SELECT state FROM evidence_submissions WHERE id=$1', [crashed.id])).rows[0].state, 'pending');
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE object_id=$1 AND action='verification.exhausted'", [crashed.id])).rows.length, 0);
    await f.db.query('ALTER TABLE audit_events DROP CONSTRAINT synthetic_exhaustion_failure');
    assert.equal((await worker.processNext(() => { throw new Error('No source fetch expected'); })).processed, false);
    const exhaustedAudit = (await f.db.query("SELECT * FROM audit_events WHERE object_id=$1 AND action IN ('verification.exhausted','evidence.unavailable') ORDER BY sequence", [crashed.id])).rows;
    assert.deepEqual(exhaustedAudit.map(row => [row.action, row.outcome]), [['verification.exhausted', 'failed'], ['evidence.unavailable', 'unavailable']]);
    for (const row of exhaustedAudit) {
      assert.equal(row.client_id, 'galaxy-evidence-worker');
      assert.equal(row.caller_binding_id, null);
      assert.equal(row.credential_scopes, null);
      assert.equal(row.http_request_id, null);
      assert.equal(row.binding_id, f.actor.bindingId);
      assert.equal(row.idempotency_key, `${row.request_id}:${row.action}`);
    }
    assert.equal((await f.db.query('SELECT * FROM verification_attempts WHERE evidence_id=$1', [crashed.id])).rows.length, 0, 'exhaustion is not a fabricated observation');
    await worker.processNext();
    assert.equal((await f.db.query("SELECT * FROM audit_events WHERE object_id=$1 AND action IN ('verification.exhausted','evidence.unavailable')", [crashed.id])).rows.length, 2);
    await assert.rejects(proofs.preview(f.actor, { id: randomUUID(), evidenceId: crashed.id }), /source_unavailable/);

    const historicalFailure = { ...payload, id: randomUUID(), source: { ...payload.source, runId: 7 } };
    await evidence.submit(f.actor, await f.authorize(historicalFailure, 'evidence.submit'));
    await f.db.query("UPDATE jobs SET state='failed',attempts=5 WHERE payload->>'evidenceId'=$1", [historicalFailure.id]);
    await worker.processNext();
    const reconciled = (await f.db.query("SELECT action FROM audit_events WHERE object_id=$1 AND action<>'evidence.submit'", [historicalFailure.id])).rows;
    assert.deepEqual(reconciled.map(row => row.action), ['evidence.unavailable'], 'do not invent when the historical job failed');

  } finally {
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await f.db.close();
  }
});
