import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { serviceFixture } from './service-fixture.mjs';
import { attachmentContractFixture } from './chat-attachments-workflow.mjs';
import { OutcomeMaterialServiceV2 } from '../src/outcome-material-v2.mjs';
import { createApi } from '../src/http.mjs';

// B read/probe only. Actual signed Binding/Consent, canonical Case/attachment/
// Outcome services and HTTP/PGlite. Object store/scanner/chat transport are
// explicit contract doubles; virtual clock controls only isolated fixtures.
async function fixture() {
  const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence'], null, { now: Math.floor(Date.now() / 1000) });
  f.access.now = f.bindings.now = f.consents.now = f.chat.now = f.attachments.now = () => f.now;
  f.chat.requireAccountWithin = async () => {};
  f.chat.transport = { available: true, project: async () => {}, send: async x => ({ archiveId: x.messageId }) };
  const contract = attachmentContractFixture(); Object.assign(f.attachments, contract);
  const materials = new OutcomeMaterialServiceV2(f.access, { consents: f.consents, chat: f.chat,
    records: f.verificationRecords, attachments: f.attachments });
  const server = createApi({ ...f, outcomeMaterials: materials, rateLimit: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, payload) => { const response = await fetch(base + path, { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.credential, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  const roomId = randomUUID(), attachmentId = randomUUID(), bytes = Buffer.from('synthetic independently selected file'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  await f.chat.create(f.actor, { roomId, operationId: randomUUID(), title: 'Outcome file lifecycle diagnostic' });
  await f.attachments.prepare(f.actor, { attachmentId, roomId, name: 'selected.txt', mediaType: 'text/plain', size: bytes.length,
    sha256, purpose: 'temporary-room-attachment', confirmed: true });
  await f.attachments.upload(f.actor, attachmentId, Readable.from([bytes]), { contentLength: bytes.length }); await f.attachments.scanPending();
  return { f, materials, contract, post, attachmentId, roomId, bytes, sha256,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.db.close(); } };
}

test('diagnostic: Outcome source selection must withhold an attachment that expires during actual object storage await', { timeout: 60000 }, async t => {
  const x = await fixture();
  try {
    await x.f.db.query('UPDATE chat_attachments SET uploaded_at=$2,expires_at=$3 WHERE id=$1', [x.attachmentId,
      new Date((x.f.now - 30 * 86400 + 1) * 1000).toISOString(), new Date((x.f.now + 1) * 1000).toISOString()]);
    const get = x.contract.store.get.bind(x.contract.store); let crossed = false;
    x.contract.store.get = async input => { const bytes = await get(input); if (!crossed) { crossed = true; x.f.now += 2; } return bytes; };
    const response = await x.post('/v2/outcome-materials/source', { kind: 'attachment', id: x.attachmentId, version: 1 });
    const current = await x.f.attachments.get(x.f.actor, { attachmentId: x.attachmentId });
    t.diagnostic('outcome_lifecycle_observed ' + JSON.stringify({ scenario: 'source-expiry-during-storage-await', crossed,
      status: response.status, returnedBinaryLength: response.body.bytes?.data?.length ?? 0, currentState: current.state,
      database: 'PGlite', objectStore: 'explicit-contract', timing: 'compressed isolated first-upload+30d interval' }));
    assert.equal(current.state, 'expired');
    assert.equal(response.status, 404, 'source selection must recheck original attachment current visibility after storage await');
  } finally { await x.close(); }
});

test('diagnostic: independent Outcome copy permission expiry during storage await must not return current-authorized bytes', { timeout: 60000 }, async t => {
  const x = await fixture();
  try {
    const caseId = randomUUID(), attemptId = randomUUID(), resultId = randomUUID();
    const facts = [
      { schemaVersion: 2, kind: 'case-created', eventId: caseId, caseId, expectedVersion: 0, actorId: x.f.actor.subjectId,
        localRef: 'synthetic-' + caseId, title: 'Outcome permission boundary', summary: 'Synthetic file copy lifecycle',
        source: { kind: 'local', reference: 'synthetic-' + caseId }, synthetic: true },
      { schemaVersion: 2, kind: 'attempt-start', eventId: attemptId, caseId, expectedVersion: 1, actorId: x.f.actor.subjectId,
        role: 'implementation', strategy: 'Selected file lifecycle', inputScopeSummary: 'Synthetic selected input', permissionScope: ['selected-context'] },
      { schemaVersion: 2, kind: 'result-recorded', eventId: resultId, caseId, expectedVersion: 2, actorId: x.f.actor.subjectId,
        origin: { kind: 'attempt', id: attemptId, version: 1 }, scopeVersion: 1, deliverableRefs: [], reportedOutcome: 'succeeded',
        summary: 'Synthetic complete-copy setup', limitations: 'Contract fixture; no external qualification' },
    ];
    for (const fact of facts) await x.f.cases.submitV2(x.f.actor, await x.f.authorize(fact, 'case.teaser.publish', { objectId: fact.eventId }));
    const materialId = randomUUID(), requestId = randomUUID(), source = { kind: 'attachment', id: x.attachmentId,
      version: 1, sha256: x.sha256, roomId: x.roomId };
    const request = { id: requestId, materialId, kind: 'request', source, caseId, purpose: 'Explicit selected synthetic result copy',
      title: 'Synthetic independent copy', audience: { visibility: 'Private', viewers: [] }, uses: ['evidence'],
      retention: 'with-related-result; independently-authorized-copy', requestExpiresAt: new Date((x.f.now + 3600) * 1000).toISOString() };
    const permission = await x.f.authorize(request, 'outcome.material', { objectId: requestId });
    const created = await x.post('/v2/outcome-materials/request', permission); assert.equal(created.status, 200, JSON.stringify(created.body));
    const approvalId = randomUUID(), approval = { id: approvalId, materialId, kind: 'approve', expectedRevision: 1,
      requestHash: createHash('sha256').update(permission.payloadJson).digest('hex'), source, license: 'authored-content',
      basis: 'authored-content', scope: 'Exactly this synthetic selected result file', expiresAt: new Date((x.f.now + 1) * 1000).toISOString(),
      independentRetention: true, temporarySourceExpiryRevokesCopy: false };
    const approved = await x.post('/v2/outcome-materials/approve', await x.f.authorize(approval, 'outcome.material', { objectId: approvalId }));
    assert.equal(approved.status, 200, JSON.stringify(approved.body)); assert.equal(approved.body.state, 'available');
    const get = x.contract.store.get.bind(x.contract.store); let crossed = false;
    x.contract.store.get = async input => { const content = await get(input); if (!crossed && input.key.startsWith('outcome-materials/')) {
      crossed = true; x.f.now += 2;
    } return content; };
    const late = await x.post('/v2/outcome-materials/read', { id: materialId, version: 1 }), next = await x.post('/v2/outcome-materials/read', { id: materialId, version: 1 });
    t.diagnostic('outcome_lifecycle_observed ' + JSON.stringify({ scenario: 'copy-permission-expiry-during-storage-await', crossed,
      status: late.status, state: late.body.state, contentAvailable: late.body.contentAvailable,
      returnedBinaryLength: late.body.bytesBase64 ? Buffer.from(late.body.bytesBase64, 'base64').length : 0,
      authorization: late.body.authorization ?? null, nextContentAvailable: next.body.contentAvailable,
      database: 'PGlite', objectStore: 'explicit-contract', permission: 'actual signed exact requester and author Consent' }));
    assert.equal(late.status, 200, 'own minimal unavailable metadata remains readable');
    assert.equal(next.body.contentAvailable, false); assert.equal(next.body.bytesBase64, undefined);
    assert.equal(late.body.contentAvailable, false, 'crossed independent copy expiry must not label the original response currently authorized');
    assert.equal(late.body.bytesBase64, undefined);
  } finally { await x.close(); }
});
