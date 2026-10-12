import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

async function fixture(publicSource) {
  const scopes = ['binding', 'consent', 'case-teaser', 'capsules', 'history'];
  const owner = await serviceFixture(scopes, null, { syntheticCommunityQuota: false });
  const reader = await serviceFixture(scopes, owner.db, { migrateDatabase: false, syntheticCommunityQuota: false });
  const api = createApi(owner);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const post = async (actor, path, input) => {
    const response = await fetch(`http://127.0.0.1:${api.address().port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.credential}` } : {}) },
      body: JSON.stringify(input),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ path, body }));
    return body;
  };
  const sign = (payload, action, publicContent = false) => owner.authorize(payload, action, {
    objectId: payload.eventId ?? payload.id, visibility: publicContent ? 'Public' : 'Private',
    purpose: publicContent ? 'public-profile' : 'operational',
  });
  const submit = async (payload, publicContent = publicSource) => {
    const signed = await sign(payload, 'case.teaser.publish', publicContent);
    await post(owner, '/v2/cases/events', signed);
    return signed;
  };
  const caseId = randomUUID();
  const root = { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0,
    actorId: owner.actor.subjectId, localRef: randomUUID(), synthetic: true,
    title: 'FICTIONAL unfinished poem', summary: 'Only mobile text layout was checked; the poem is unfinished.',
    source: { kind: 'local', reference: randomUUID() } };
  const event = (kind, expectedVersion, extra) => ({ schemaVersion: 2, kind, eventId: randomUUID(), caseId,
    expectedVersion, actorId: owner.actor.subjectId, ...extra });
  try {
    await submit(root);
    const attempt = event('attempt-start', 1, { role: 'implementation', strategy: 'Only inspect the selected text layout.',
      inputScopeSummary: 'Selected paragraphs', permissionScope: ['selected-context'], environment: { name: 'browser', version: 'unknown' } });
    await submit(attempt);
    await submit(event('attempt-start', 2, { role: 'implementation', strategy: 'PRIVATE UNSELECTED BACKGROUND',
      inputScopeSummary: 'PRIVATE DRAFT', permissionScope: ['selected-context'], environment: { name: 'browser', version: 'unknown' } }), false);
    const result = event('result-recorded', 3, { origin: { kind: 'attempt', id: attempt.eventId, version: 1 },
      scopeVersion: 1, deliverableRefs: [], reportedOutcome: 'succeeded', summary: 'Two selected paragraphs fit at 390 pixels.',
      limitations: 'No actual reader study; no judgment about poem quality or completion.' });
    const resultGrant = await submit(result);
    const version = { schemaVersion: 2, kind: 'version', id: randomUUID(), capsuleId: randomUUID(), expectedRevision: 0, version: 1,
      publicationClass: 'formal-source-success', synthetic: true, title: 'FICTIONAL narrow mobile layout method',
      problemPattern: 'Reading selected paragraphs on a small display', environment: { name: 'browser', version: 'unknown' },
      solutionStrategy: 'Keep readable line lengths in the selected paragraphs.', tools: [], skills: [], mcpRefs: [],
      verificationMethod: 'A synthetic browser check at 390 pixels.', limitations: ['Not a reader study'],
      capabilityId: 'software-debugging', applicableScope: 'Only selected paragraph layout', license: 'MIT', contributors: [],
      sourceResolution: { caseId, resultId: result.eventId, resultVersion: 1, proofIds: [], verificationRefs: [] },
      sourceRefs: [], permissionRefs: [], attributionRefs: [], externalReferences: [], redactionConfirmed: true };
    await post(owner, '/v2/capsules/events', await sign(version, 'capsule.publish', true));
    return { owner, reader, root, result, resultGrant, version, submit, event,
      read: actor => post(actor, '/v2/capsules/read', { capsuleId: version.capsuleId, versionId: version.id }),
      close: async () => { await new Promise(resolve => api.close(resolve)); await owner.db.close(); } };
  } catch (error) { await new Promise(resolve => api.close(resolve)); await owner.db.close(); throw error; }
}

test('method reading exposes only the reader-authorized exact root/result, without the private work or a newer correction', async () => {
  const f = await fixture(true);
  try {
    const initial = await f.read(null);
    assert.equal(initial.sourceReading.case.title, f.root.title);
    assert.equal(initial.sourceReading.case.summary, f.root.summary);
    assert.equal(initial.sourceReading.result.summary, f.result.summary);
    assert.equal(initial.sourceReading.result.limitations, f.result.limitations);
    assert.equal(initial.sourceReading.result.reportedOutcome, 'succeeded');
    assert.equal(initial.sourceReading.result.ref.version, 1);
    assert.equal(initial.sourceReading.result.currentness, 'current');
    assert.equal(JSON.stringify(initial).includes('PRIVATE UNSELECTED BACKGROUND'), false);
    assert.equal(JSON.stringify(initial).includes('PRIVATE DRAFT'), false);
    const correction = { ...f.result, eventId: randomUUID(), expectedVersion: 4,
      supersedes: { id: f.result.eventId, version: 1 }, reportedOutcome: 'partial', summary: 'PRIVATE NEWER RESULT' };
    await f.submit(correction, false);
    const old = await f.read(f.reader);
    assert.equal(old.sourceStatus, 'source-result-superseded');
    assert.equal(old.sourceReading.result.summary, f.result.summary);
    assert.equal(old.sourceReading.result.currentness, 'superseded');
    assert.equal(JSON.stringify(old).includes(correction.eventId), false);
    assert.equal(JSON.stringify(old).includes(correction.summary), false);
    await f.owner.consents.revoke(f.owner.actor, f.resultGrant.consentId);
    const revoked = await f.read(null);
    assert.equal(revoked.version, null);
    assert.equal(revoked.sourceReading, undefined);
    assert.equal(JSON.stringify(revoked).includes(f.result.summary), false);
  } finally { await f.close(); }
});

test('publishing a method does not grant public or another signed-in reader access to private source summaries', async () => {
  const f = await fixture(false);
  try {
    for (const actor of [null, f.reader]) {
      const view = await f.read(actor);
      assert.equal(view.version.title, f.version.title);
      assert.equal(view.sourceReading.case.status, 'unavailable');
      assert.equal(view.sourceReading.result.status, 'unavailable');
      assert.equal(JSON.stringify(view).includes(f.root.summary), false);
      assert.equal(JSON.stringify(view).includes(f.result.summary), false);
    }
    const own = await f.read(f.owner);
    assert.equal(own.sourceReading.case.summary, f.root.summary);
    assert.equal(own.sourceReading.result.summary, f.result.summary);
    assert.equal(own.readingIsReuse, false);
    assert.equal(own.capabilityVerified, false);
  } finally { await f.close(); }
});
