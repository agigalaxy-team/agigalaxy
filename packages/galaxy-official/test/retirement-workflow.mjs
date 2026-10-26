import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { CompactSign } from 'jose';
import { serviceFixture } from './service-fixture.mjs';
import { createGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { createRetirementController } from "../src/privacy/retirement.mjs";
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createDataExportClient } from "../src/clients/data-export.mjs";
import { deletionPreview } from '../src/operations/deletion-preview.mjs';

export const retirementFixturePolicy = (base = 2000000000) => ({ version: 1, id: 'synthetic-exit-v1', endpoint: 'https://official.example.org',
  operator: 'Synthetic operator', reason: 'Isolated retirement rehearsal', announcedAt: base + 10, stopWritesAt: base + 20,
  takeoutUntil: base + 120, statusUntil: base + 180, contactUrl: 'https://official.example.org/contact', deletionPolicyUrl: 'https://official.example.org/deletion' });

export async function verifyRetirementWorkflow(database = null, options = {}) {
  const base = 2000000000; let current = base;
  const policy = retirementFixturePolicy(base), retirement = createRetirementController(policy, { endpoint: policy.endpoint, now: () => current });
  const scopes = ['binding', 'consent', 'case-teaser', 'proof', 'data-export'];
  const f = await serviceFixture(scopes, database, { ...options, now: base, retirement });
  const sessions = createSessionMemory({ now: () => current, isCurrent: async () => true });
  sessions.adopt({ endpoint: policy.endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId, scopes,
    expiresAt: base + 500, bindingExpiresAt: base + 900, takeCredential: () => f.credential });
  const api = createApi({ ...f, rateLimit: 200 }); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  const request = async (method, path, input = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${f.credential}` },
      ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const client = createDataExportClient({ endpoint: policy.endpoint, sessions, now: () => current, send: async (url, input) => {
    const result = await request('POST', new URL(url).pathname, JSON.parse(input.bodyJson));
    if (result.status !== 200) throw new Error(result.data.error); return result.data;
  } });
  try {
    assert.equal(retirement.phase(), 'normal');
    const root = { id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'Exit rehearsal', summary: 'Synthetic private data',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
    const grant = await f.authorize(root); await f.cases.submit(f.actor, grant);
    const strangerKeys = generateKeyPairSync('ed25519');
    const stranger = createGalaxyGenesis({ publicKeyPem: strangerKeys.publicKey.export({ type: 'spki', format: 'pem' }), originCode: '5' });
    const enrollment = { subjectId: stranger.id, genesisProof: stranger.genesisProof, installationId: randomUUID(), scopes: ['binding', 'data-export'] };
    const pending = await f.bindings.challenge(enrollment);
    current = base + 10; assert.equal(retirement.phase(), 'announced'); assert.equal(retirement.canProcessEvidence(), true);
    current = base + 20; assert.equal(retirement.phase(), 'takeout'); assert.equal(retirement.canProcessEvidence(), false);
    const notice = await request('GET', '/v1/service-status'); assert.equal(notice.status, 200); assert.equal(notice.data.phase, 'takeout');
    assert.equal((await request('POST', '/v1/cases', grant)).status, 410);
    assert.equal((await request('POST', '/v1/consents', {})).data.error, 'service_writes_stopped');
    await assert.rejects(f.bindings.challenge(enrollment), /service_enrollment_stopped/);
    const signature = await new CompactSign(Buffer.from(pending.challenge)).setProtectedHeader({ alg: 'Ed25519', typ: 'galaxy-binding-response+jws' }).sign(strangerKeys.privateKey);
    await assert.rejects(f.bindings.bind({ challenge: pending.challenge, clientSession: pending.clientSession, signature }), /service_enrollment_stopped/);
    const renewal = await f.bindings.challenge({ subjectId: f.actor.subjectId, genesisProof: f.genesis.genesisProof, installationId: randomUUID(), scopes });
    const renewed = await f.bindings.bind({ challenge: renewal.challenge, clientSession: renewal.clientSession,
      signature: await f.signForTest(renewal.challenge, 'galaxy-binding-response+jws') });
    assert.ok(renewed.bindingId);
    assert.equal((await client.specification()).serviceStatus.phase, 'takeout');
    const ticket = await client.create({ datasets: ['identity', 'cases', 'consents'] });
    assert.equal(ticket.expiresAt, policy.takeoutUntil);
    const pages = []; const copied = await client.download(ticket.id, { onPage: page => pages.push(page) });
    assert.equal(copied.complete, true); assert.equal(pages.length, 3);
    assert.deepEqual(pages[0].items[0].genesis_proof, f.genesis.genesisProof);
    const preview = await deletionPreview(f.db, f.actor.subjectId);
    assert.equal(preview.physicalDeletionPerformed, false);
    // The original 32 v1 datasets are not the denominator after additive v2
    // lifecycle registration. Check actual owned data and empty new categories.
    assert.equal(preview.ownedDatasets.tasks,0);
    assert.equal(preview.ownedDatasets['identity-control-events'],0);
    assert.equal(preview.ownedDatasets['external-identity-links'],0);
    assert.equal(preview.ownedDatasets['profile-statements'],0);assert.equal(preview.ownedDatasets['builder-probes'],0);
    assert.equal(preview.ownedDatasets.cases, 1); assert.equal(preview.ownedDatasets.identity, 1);
    assert.equal((await request('POST', `/v1/consents/${grant.consentId}/revoke`)).status, 200);
    await assert.rejects(f.cases.get(f.actor, root.id), /consent/);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM cases WHERE id=$1', [root.id])).rows[0].count), 1);
    current = policy.takeoutUntil;
    assert.equal((await request('POST', '/v1/data-exports/page', { id: ticket.id, dataset: 'identity' })).status, 410);
    assert.equal((await request('POST', '/v1/session-challenges')).status, 410);
    await assert.rejects(f.dataExport.page(f.actor, { id: ticket.id, dataset: 'identity' }), /service_takeout_closed/);
    const unknownProofPath = `/v1/proofs/${randomUUID()}/status`;
    assert.equal((await request('GET', unknownProofPath)).status, 404);
    current = policy.statusUntil;
    assert.equal((await request('GET', unknownProofPath)).status, 410);
    assert.equal((await request('GET', '/v1/service-status')).data.phase, 'closed');
    return { phases: 5, takeoutDeadlineEnforced: true, existingSubjectRebind: true, newEnrollmentBlocked: true,
      exportAndRevocation: true, deletionPreviewOnly: true, physicalDeletionPerformed: false };
  } finally {
    sessions.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!database) await f.db.close();
  }
}
