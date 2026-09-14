import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

// The matrix exercises the current subject/explicit-viewer model. Organization
// roles are not implemented; unrecognized organization claims must grant nothing.
export async function verifyVisibilityAcceptance(database = null, options = {}) {
  const scopes = ['binding', 'consent', 'case-teaser', 'history', 'evidence', 'proof'];
  const f = await serviceFixture(scopes, database, options);
  const viewer = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const stranger = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const api = createApi({ ...f, rateLimit: 512, searchPageLimit: 200 });
  const worker = new EvidenceService(null, new ConsentReader({ now: () => f.now, readGrant: options.workerReads?.readGrant }),
    { db: options.workerDb ?? f.db, endpoint: f.bindings.endpoint, now: () => f.now, readCase: options.workerReads?.readCase });
  let calls = 0;
  const groups = {}, publicAudience = { visibility: 'Public', purpose: 'public-profile' };
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${api.address().port}`;
  async function request(path, payload, actor = null, headers = {}) {
    calls++;
    const response = await fetch(address + path, { method: payload === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: 'Bearer ' + String(actor.credential) } : {}), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (body.requestId) { assert.equal(body.requestId, response.headers.get('x-request-id')); delete body.requestId; }
    return { status: response.status, body };
  }
  async function ok(path, payload, actor = null, headers = {}) {
    const result = await request(path, payload, actor, headers);assert.equal(result.status, 200, path);return result.body;
  }
  async function createCase(title, audience = {}) {
    const payload = { id: randomUUID(), kind: 'case', localRef: randomUUID(), title, summary: title + ' summary',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const grant = await f.authorize(payload, 'case.teaser.publish', audience);
    await ok('/v1/cases', grant, f);return { payload, grant };
  }
  const query = (actor = null, input = {}, headers = {}) => ok('/v1/history/query', { subjectId: f.actor.subjectId, ...input }, actor, headers);
  const caseIds = page => page.items.map(item => item.caseId).sort((a, b) => a.localeCompare(b));
  const expectedIds = values => values.map(value => value.payload.id).sort((a, b) => a.localeCompare(b));
  try {
    const privateCase = await createCase('private-marker-' + randomUUID());
    const shared = await createCase('viewer-marker-' + randomUUID(), { viewers: [viewer.actor.subjectId] });
    const hubOnly = await createCase('hub-marker-' + randomUUID(), { visibility: 'Hub-scoped', recipient: f.bindings.endpoint, viewers: [viewer.actor.subjectId] });
    const proofOnly = await createCase('proof-only-marker-' + randomUUID(), { visibility: 'Proof-only', viewers: [viewer.actor.subjectId] });
    const publicCase = await createCase('public-marker-' + randomUUID(), publicAudience);
    assert.deepEqual(caseIds(await query(f)), expectedIds([privateCase, shared, hubOnly, proofOnly, publicCase]));
    assert.deepEqual(caseIds(await query(viewer)), expectedIds([shared, publicCase]));
    assert.deepEqual(caseIds(await query(stranger)), expectedIds([publicCase]));
    assert.deepEqual(caseIds(await query()), expectedIds([publicCase]));
    for (const item of (await query(viewer)).items) {
      assert.equal(item.fieldPolicy.view, 'authorized');
      for (const field of ['source', 'participants', 'registeredAt']) assert.equal(item[field], undefined);
    }
    groups.explicitViewerAndVisibilityMatrix = true;

    const hidden = [privateCase, shared, hubOnly, proofOnly];
    const unknownCase = randomUUID();
    for (const sample of hidden) {
      const denied = await request('/v1/cases/' + sample.payload.id, undefined, stranger);
      assert.deepEqual(denied, await request('/v1/cases/' + unknownCase, undefined, stranger));
      assert.equal(denied.status, 404);
    }
    // Private aggregate reads remain owner-only even for a shared projection.
    assert.equal((await request('/v1/cases/' + shared.payload.id, undefined, viewer)).status, 404);
    assert.equal((await request('/v1/cases/' + shared.payload.id, undefined, f)).status, 200);
    const missingGrant = await request('/v1/consents/' + randomUUID() + '/revoke', {}, stranger);
    assert.equal(missingGrant.status, 404);
    assert.deepEqual(await request('/v1/consents/' + privateCase.grant.consentId + '/revoke', {}, stranger), missingGrant);
    const foreignBindings = await ok('/v1/bindings/query', {}, stranger);
    assert.ok(!JSON.stringify(foreignBindings).includes(f.actor.bindingId));
    const strangerGrants = await ok('/v1/consents', undefined, stranger);
    assert.equal(strangerGrants.items.length, 0);
    groups.ownedObjectsDoNotRevealForeignIds = true;

    const emptyProfile = await query(stranger);
    const profile = { id: randomUUID(), expectedRevision: 0, selfDeclared: { about: 'private-profile-' + randomUUID() } };
    const profileGrant = await f.authorize(profile, 'profile.publish');await ok('/v1/profiles/statements', profileGrant, f);
    assert.deepEqual(await query(stranger), emptyProfile);
    assert.equal((await query(f)).selfDeclared.about, profile.selfDeclared.about);
    const snapshots = [];
    for (const actor of [null, stranger]) {
      const first = await query(actor, { limit: 1 });
      assert.equal(first.nextCursor, null);assert.equal(first.pageSummary.cases, 1);
      const typed = await ok('/v1/search/query', { type: 'case', query: { subjectId: f.actor.subjectId, limit: 1 } }, actor);
      assert.equal(typed.pageCount, 1);assert.equal(typed.countsScope, 'visible-page-only');
      snapshots.push({ actor, first, typed });
    }
    for (let index = 0; index < 5; index++) await createCase(publicCase.payload.title);
    for (const { actor, first, typed } of snapshots) {
      assert.deepEqual(await query(actor, { limit: 1 }), first);
      assert.deepEqual(await ok('/v1/search/query', { type: 'case', query: { subjectId: f.actor.subjectId, limit: 1 } }, actor), typed);
      for (const sample of hidden) {
        const page = await query(actor, { query: sample.payload.title });assert.equal(page.items.length, 0);
        assert.equal(page.pageSummary.cases, 0);assert.equal(page.nextCursor, null);
        assert.ok(!JSON.stringify(page).includes(sample.payload.id));
      }
    }
    groups.privateChangesDoNotChangePublicSummariesOrCursors = true;

    const forged = { 'X-Organization-Id': 'synthetic-owner-org', 'X-Galaxy-Subject-Id': f.actor.subjectId,
      'X-Hub-Endpoint': f.bindings.endpoint, 'X-Role': 'admin' };
    assert.deepEqual(await query(stranger, {}, forged), await query(stranger));
    assert.deepEqual(await query(null, {}, forged), await query());
    for (const [field, value] of [['organizationId', 'synthetic-owner-org'], ['viewerId', f.actor.subjectId], ['hubEndpoint', f.bindings.endpoint]]) {
      assert.equal((await request('/v1/history/query', { subjectId: f.actor.subjectId, [field]: value }, stranger)).status, 400);
    }
    for (const actor of [null, stranger, viewer]) {
      assert.equal((await request('/v1/history/query', { subjectId: f.actor.subjectId, environment: 'owner-only' }, actor)).status, 403);
    }
    groups.organizationAndHubClaimsCannotExpandAccess = true;

    const attempt = { id: randomUUID(), kind: 'attempt', caseId: privateCase.payload.id, expectedVersion: 1, sequence: 1,
      approach: 'private-approach-' + randomUUID(), configuration: { environment: 'Synthetic', version: '1', tools: [] } };
    await ok('/v1/case-events', await f.authorize(attempt), f);
    const result = { id: randomUUID(), kind: 'result', caseId: privateCase.payload.id, expectedVersion: 2, attemptId: attempt.id,
      outcome: 'failed', summary: 'Private result', failureReason: 'Synthetic', limitations: ['Synthetic only'] };
    await ok('/v1/case-events', await f.authorize(result), f);
    const evidence = { id: randomUUID(), caseId: privateCase.payload.id, resultId: result.id,
      source: { provider: 'github-actions', owner: 'fixture', repository: 'visibility-' + randomUUID(), runId: 975, attempt: 1, commit: 'c'.repeat(40) } };
    const evidenceGrant = await f.authorize(evidence, 'evidence.submit');
    assert.equal((await request('/v1/evidence-submissions', evidenceGrant, f)).status, 202);
    await worker.processNext((source, now) => inspectGithubRun(source, { id: source.runId, run_attempt: 1, head_sha: source.commit,
      repository: { full_name: source.owner + '/' + source.repository, id: 975, private: false }, updated_at: new Date(now * 1000).toISOString(),
      status: 'completed', conclusion: 'success' }, now));
    const proofs = [];
    for (const audience of [{}, { visibility: 'Proof-only', viewers: [viewer.actor.subjectId] }, publicAudience]) {
      const preview = await ok('/v1/proof-previews', { id: randomUUID(), evidenceId: evidence.id }, f);
      const grant = await f.authorize(JSON.parse(preview.payloadJson), 'proof.publish', audience);
      proofs.push({ ...await ok('/v1/proofs', grant, f), grant });
    }
    const [privateProof, sharedProof, publicProof] = proofs;
    for (const actor of [null, stranger]) {
      const missing = await request('/v1/proofs/' + randomUUID(), undefined, actor);assert.equal(missing.status, 404);
      for (const proof of [privateProof, sharedProof]) {
        assert.deepEqual(await request('/v1/proofs/' + proof.proofId, undefined, actor), missing);
        assert.deepEqual(await request('/v1/proofs/' + proof.proofId + '/status', undefined, actor), missing);
      }
    }
    assert.equal((await request('/v1/proofs/' + sharedProof.proofId, undefined, viewer)).status, 200);
    for (const actor of [null, stranger, viewer]) {
      const page = await ok('/v1/search/query', { type: 'proof', query: { subjectId: f.actor.subjectId } }, actor);
      const expected = (actor === viewer ? [sharedProof.proofId, publicProof.proofId] : [publicProof.proofId]).sort((a, b) => a.localeCompare(b));
      assert.deepEqual(page.items.map(item => item.id).sort((a, b) => a.localeCompare(b)), expected);
      const projected = await ok('/v1/proofs/' + publicProof.proofId, undefined, actor);
      for (const value of [privateCase.payload.id, privateCase.payload.title, attempt.approach, profile.selfDeclared.about])
        assert.ok(!JSON.stringify({ page, projected }).includes(value));
    }
    groups.proofOnlyAccessDoesNotDisclosePrivateCase = true;
    const unknownEvidence = await request('/v1/verifications/' + randomUUID(), undefined, stranger);
    assert.equal(unknownEvidence.status, 404);
    assert.deepEqual(await request('/v1/verifications/' + evidence.id, undefined, stranger), unknownEvidence);

    await ok('/v1/consents/' + shared.grant.consentId + '/revoke', {}, f);
    assert.ok(!caseIds(await query(viewer)).includes(shared.payload.id));
    await ok('/v1/consents/' + sharedProof.grant.consentId + '/revoke', {}, f);
    assert.equal((await request('/v1/proofs/' + sharedProof.proofId, undefined, viewer)).status, 404);
    await ok('/v1/consents/' + publicCase.grant.consentId + '/revoke', {}, f);
    assert.equal((await query()).items.length, 0);
    await ok('/v1/consents/' + evidenceGrant.consentId + '/revoke', {}, f);
    assert.equal((await request('/v1/proofs/' + publicProof.proofId, undefined)).status, 404);
    assert.equal((await ok('/v1/search/query', { type: 'proof', query: { subjectId: f.actor.subjectId } })).items.length, 0);
    groups.revocationsImmediatelyRemovePreviouslyVisibleObjects = true;
    return { groups, httpRequests: calls, syntheticOnly: true, organizationRolesImplemented: false,
      organizationClaimBehavior: 'no authority; unknown body fields rejected', publicHttpsVerified: false,
      requestRateLimitInFixture: 512, schema: (await f.db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version };
  } finally {
    api.closeAllConnections();await new Promise(resolve => api.close(resolve));if (!database) await f.db.close();
  }
}
