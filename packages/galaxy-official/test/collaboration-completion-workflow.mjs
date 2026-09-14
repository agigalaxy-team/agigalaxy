import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createAssistanceFlow } from '../src/assistance-flow.mjs';
import { createAssistanceClient } from '../src/assistance-client.mjs';
import { createContextFlow } from '../src/context-flow.mjs';
import { createContextClient } from '../src/context-client.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export async function verifyCollaborationCompletion(database = null, options = {}) {
  const scopes = ['binding', 'consent', 'case-teaser', 'assistance', 'context', 'evidence', 'proof', 'history'];
  const f = await serviceFixture(scopes, database, options);
  const provider = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const other = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const endpoint = f.bindings.endpoint, publicGrant = { visibility: 'Public', purpose: 'public-profile' };
  const api = createApi({ ...f, rateLimit: 256 });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, memories = [], measurements = [];
  let requests = 0;
  async function transport(url, input, method = 'POST') {
    requests++;
    const target = new URL(url);
    const response = await fetch(origin + target.pathname + target.search, { method, headers: {
      'Content-Type': 'application/json', ...(input.credential ? { Authorization: `Bearer ${input.credential}` } : {})
    }, ...(method === 'POST' ? { body: input.bodyJson } : {}), signal: input.signal });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status });
    return data;
  }
  const read = (url, input) => transport(url, input, 'GET');
  function clients(who) {
    const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
    memories.push(sessions);
    sessions.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes,
      expiresAt: f.now + 500, bindingExpiresAt: f.now + 1000, takeCredential: () => who.credential });
    return {
      assistance: createAssistanceClient({ endpoint, sessions, send: transport, read }),
      flow: createAssistanceFlow({ endpoint, sessions, signIntent: who.signForTest, now: () => f.now,
        consentSend: transport, assistanceSend: transport, assistanceRead: read }),
      context: createContextClient({ endpoint, sessions, send: transport, read }),
      materials: createContextFlow({ endpoint, sessions, signIntent: who.signForTest, now: () => f.now,
        consentSend: transport, contextSend: transport, contextRead: read, assistanceSend: transport, assistanceRead: read })
    };
  }
  const owner = clients(f), selected = clients(provider), outsider = clients(other);
  async function execute(flow, input) {
    const preview = await flow.prepare(input);
    const receipt = await flow.execute(preview, preview.confirmation);
    return { preview, receipt };
  }
  async function publishCase(payload) {
    return transport(endpoint + (payload.kind === 'case' ? '/v1/cases' : '/v1/case-events'), { credential: f.credential,
      bodyJson: JSON.stringify(await f.authorize(payload, 'case.teaser.publish', publicGrant)) });
  }
  const worker = new EvidenceService(null, new ConsentReader({ now: () => f.now, readGrant: options.workerReads?.readGrant }),
    { db: options.workerDb ?? f.db, endpoint, now: () => f.now, readCase: options.workerReads?.readCase });
  try {
    for (const collaboration of ['open-assistance', 'basic-bounty']) {
      const startRequests = requests;
      const root = { kind: 'case', id: randomUUID(), localRef: randomUUID(), title: `Synthetic ${collaboration} completion`,
        summary: 'Selected materials to delivery and bounded CI observation', source: { kind: 'local', reference: randomUUID() },
        participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
      await publishCase(root);
      const request = { id: randomUUID(), caseId: root.id, title: 'Inspect compiler and propose a repair',
        problem: 'Synthetic missing dependency', attemptedApproaches: [], scope: 'Read selected diagnostics',
        visibility: 'Public', collaboration, enrollmentExpiresAt: f.now + 1000,
        ...(collaboration === 'basic-bounty' ? { budget: { mode: 'fixed', amount: '10', unit: 'external-unit' } } : {}) };
      await execute(owner.flow, { request });
      const event = (who, kind, fields = {}) => execute(who.flow, { assistanceId: request.id, event: { kind, ...fields } });
      const offer = await event(selected, 'offer', { proposal: 'Inspect and repair', scope: request.scope,
        ...(collaboration === 'basic-bounty' ? { quote: { mode: 'fixed', amount: '10', unit: 'external-unit' } } : {}) });
      await event(outsider, 'offer', { proposal: 'Unselected private proposal', scope: request.scope });
      assert.equal((await owner.assistance.get(request.id)).state, 'open');
      const material = stage => ({ kind: 'grant', assistanceId: request.id, expiresAt: f.now + 400,
        materials: [{ label: `Stage ${stage}`, content: `SYNTHETIC-SELECTED-CONTEXT-${stage}` }] });
      await assert.rejects(owner.materials.prepare(material(1)), /active collaboration/);
      const selection = await owner.flow.prepare({ assistanceId: request.id, event: { kind: 'select', offerId: offer.preview.eventId } });
      const beforeWrongConfirmation = requests;
      await assert.rejects(owner.flow.execute(selection, 'wrong'), /confirmation/);
      assert.equal(requests, beforeWrongConfirmation);
      await owner.flow.execute(selection, selection.confirmation);
      assert.equal((await selected.assistance.get(request.id)).state, 'awaiting-confirmation');
      await assert.rejects(owner.materials.prepare(material(1)), /active collaboration/);
      await event(selected, 'confirm');
      const first = await execute(owner.materials, material(1));
      const pending = await selected.context.get(first.receipt.grantId);
      assert.equal(pending.contextAccessGranted, false);
      assert.equal(pending.materials[0].content, undefined);
      await assert.rejects(outsider.context.get(first.receipt.grantId), /not_found/);
      await execute(selected.materials, { kind: 'accept', grantId: first.receipt.grantId });
      assert.equal((await selected.context.get(first.receipt.grantId)).materials[0].content, material(1).materials[0].content);
      await event(owner, 'change-scope', { scope: 'Inspect a selected patch and run verification', reason: 'Proceed to stage two' });
      await assert.rejects(selected.context.get(first.receipt.grantId), /collaboration_changed/);
      await assert.rejects(owner.materials.prepare(material(2)), /active collaboration/);
      await event(selected, 'confirm-scope');
      const second = await execute(owner.materials, material(2));
      assert.equal((await selected.context.get(second.receipt.grantId)).materials[0].content, undefined);
      await execute(selected.materials, { kind: 'accept', grantId: second.receipt.grantId });
      assert.equal((await selected.context.get(second.receipt.grantId)).materials[0].content, material(2).materials[0].content);
      await assert.rejects(selected.context.get(first.receipt.grantId), /collaboration_changed/);
      const attempt = { kind: 'attempt', id: randomUUID(), caseId: root.id, expectedVersion: 1, sequence: 1,
        approach: 'Apply selected synthetic repair', configuration: { environment: 'test', version: '1', tools: ['compiler'] } };
      await publishCase(attempt);
      const result = { kind: 'result', id: randomUUID(), caseId: root.id, expectedVersion: 2, attemptId: attempt.id,
        outcome: 'succeeded', summary: 'Requester-reported synthetic outcome', failureReason: '', limitations: ['Synthetic Case; CI is a separate execution fact'] };
      await publishCase(result);
      const evidence = { id: randomUUID(), caseId: root.id, resultId: result.id,
        source: { provider: 'github-actions', owner: 'fixture', repository: collaboration, runId: 1, attempt: 1, commit: 'a'.repeat(40) } };
      await transport(endpoint + '/v1/evidence-submissions', { credential: f.credential,
        bodyJson: JSON.stringify(await f.authorize(evidence, 'evidence.submit', { viewers: [provider.actor.subjectId] })) });
      const observation = await worker.processNext((source, now) => inspectGithubRun(source, {
        id: 1, run_attempt: 1, head_sha: source.commit, repository: { id: collaboration === 'basic-bounty' ? 124 : 123,
          full_name: `${source.owner}/${source.repository}`, private: false },
        updated_at: new Date(now * 1000).toISOString(), status: 'completed', conclusion: 'success'
      }, now));
      assert.equal(observation.state, 'observed');
      const proofPreview = await f.proofs.preview(f.actor, { id: randomUUID(), evidenceId: evidence.id });
      const proof = await f.proofs.publish(f.actor, await f.authorize(JSON.parse(proofPreview.payloadJson), 'proof.publish', publicGrant));
      const delivery = await event(selected, 'deliver', { attemptId: attempt.id, evidenceIds: [evidence.id], summary: 'Completed selected work with a CI observation' });
      assert.equal((await owner.assistance.get(request.id)).state, 'delivered');
      assert.equal((await owner.assistance.get(request.id)).paymentExecuted, false);
      await event(owner, 'accept', { deliveryId: delivery.preview.eventId, summary: 'Requester explicitly accepts this synthetic delivery' });
      const completed = await selected.assistance.get(request.id);
      assert.equal(completed.state, 'accepted');
      assert.equal(completed.paymentExecuted, false);
      assert.equal(completed.capabilityVerified, false);
      assert.ok(!(await selected.assistance.get(request.id)).offers.some(item => item.proposal === 'Unselected private proposal'));
      assert.equal((await f.proofs.get(provider.actor, proof.proofId)).signed, proof.signed);
      await assert.rejects(selected.context.get(second.receipt.grantId), /context_collaboration_changed/);
      const revoked = await execute(owner.materials, { kind: 'revoke', grantId: second.receipt.grantId });
      assert.equal(revoked.receipt.state, 'revoked');
      assert.ok((await f.db.query('SELECT revoked_at FROM context_grants WHERE id=$1', [second.receipt.grantId])).rows[0].revoked_at);
      await assert.rejects(selected.context.get(second.receipt.grantId), /context_collaboration_changed/);
      measurements.push({ collaboration, httpRequests: requests - startRequests, finalState: completed.state,
        explicitSelection: true, bilateralConfirmation: true, contextStages: 2, oldStageInvalidated: true, acceptanceClosesContext: true,
        resultRecorded: true, ciObservation: true, proofPublished: true, paymentExecuted: false, capabilityVerified: false });
    }
    const audit = (await f.db.query('SELECT * FROM audit_events WHERE actor=ANY($1::text[])', [[f.actor.subjectId, provider.actor.subjectId, other.actor.subjectId]])).rows;
    assert.ok(!JSON.stringify(audit).includes('SYNTHETIC-SELECTED-CONTEXT-'));
    return { scenarios: measurements, httpRequests: requests, syntheticOnly: true, realHumanActionsVerified: false };
  } finally {
    memories.forEach(memory => memory.close());
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
    if (!database) await f.db.close();
  }
}
