import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createDataExportClient } from '../src/data-export-client.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createHostConnectionController } from '../src/host-connection-controller.mjs';
import { saveDataExport } from '../src/local-data-export.mjs';
import { ownerExportDatasets as exportDatasets } from '../src/shared/data-export-schema.mjs';
import { cleanupExpiredExports } from '../src/infrastructure/export-retention.mjs';
import { EvidenceService } from '../src/evidence.mjs';
import { ConsentReader } from '../src/consent-reader.mjs';
import { inspectGithubRun } from '../src/github-evidence.mjs';

export async function verifyDataExportWorkflow(database = null, options = {}) {
  const scopes = ['binding', 'consent', 'case-teaser', 'evidence', 'proof', 'data-export'];
  const f = await serviceFixture(scopes, database, options);
  const other = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-export-workflow-'));
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  sessions.adopt({ endpoint: f.access.endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId, scopes,
    expiresAt: f.now + 500, bindingExpiresAt: f.now + 900, takeCredential: () => f.credential });
  const api = createApi({ ...f, rateLimit: 300 }); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  let tamper = false, rateLimitOnce = false, retries = 0;
  const send = async (url, input) => {
    if (rateLimitOnce) { rateLimitOnce = false; retries++; const error = new Error('Synthetic rate limit'); error.code = 'GALAXY_RATE_LIMITED'; error.retryAfterSeconds = 1; throw error; }
    const response = await fetch(origin + new URL(url).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${input.credential}` }, body: input.bodyJson, signal: input.signal });
    const data = await response.json(); if (response.status !== 200) throw new Error(data.error);
    if (tamper && url.endsWith('/page')) data.items.push({ id: 'tampered' });
    return data;
  };
  const client = createDataExportClient({ endpoint: f.access.endpoint, sessions, send, now: () => f.now });
  const host = createHostConnectionController({ endpoint: f.access.endpoint, sessions, dataExportClient: client,
    saveExportToDirectory: (id, directory, opts) => saveDataExport(client, id, directory, opts) });
  try {
    const makeCase = who => ({ id: randomUUID(), kind: 'case', localRef: randomUUID(), title: 'Owner export fixture', summary: 'Private fixture',
      source: { kind: 'local', reference: randomUUID() }, participants: [{ subjectId: who.actor.subjectId, role: 'requester' }] });
    const parent = makeCase(f), grant = await f.authorize(parent); await f.cases.submit(f.actor, grant);
    const foreign = makeCase(other); await other.cases.submit(other.actor, await other.authorize(foreign));
    const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1, approach: 'Fixture',
      configuration: { environment: 'test', version: '1', tools: [] } }; await f.cases.submit(f.actor, await f.authorize(attempt));
    const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id, outcome: 'succeeded',
      summary: 'Fixture outcome', failureReason: '', limitations: ['Synthetic'] }; await f.cases.submit(f.actor, await f.authorize(result));
    const evidence = { id: randomUUID(), caseId: parent.id, resultId: result.id, source: {
      provider: 'github-actions', owner: 'fixture', repository: 'example', runId: 1, attempt: 1, commit: 'a'.repeat(40) } };
    await f.evidence.submit(f.actor, await f.authorize(evidence, 'evidence.submit'));
    const worker = new EvidenceService(null, new ConsentReader({ now: () => f.now, readGrant: options.workerReads?.readGrant }), {
      db: options.workerDatabase ?? f.db, endpoint: f.access.endpoint, now: () => f.now,
      ...(options.workerReads ? { readCase: options.workerReads.readCase } : {}) });
    // A shared PostgreSQL context can contain earlier jobs; target this fixture's
    // pending job by processing until its own observed state is reached.
    let observed = false;
    for (let i = 0; i < 100; i++) {
      await worker.processNext((source, now) => inspectGithubRun(source, { id: source.runId, run_attempt: source.attempt, head_sha: source.commit,
        repository: { full_name: `${source.owner}/${source.repository}`, private: false, id: 123 }, updated_at: new Date(now * 1000).toISOString(), status: 'completed', conclusion: 'success' }, now));
      if ((await f.evidence.get(f.actor, evidence.id)).state === 'observed') { observed = true; break; }
    }
    assert.equal(observed, true);
    const preview = await f.proofs.preview(f.actor, { id: randomUUID(), evidenceId: evidence.id });
    const proof = await f.proofs.publish(f.actor, await f.authorize(JSON.parse(preview.payloadJson), 'proof.publish'));
    await assert.rejects(f.dataExport.create(other.actor, { id: randomUUID(), datasets: ['authorized-views'], views: [{ kind: 'proof', id: proof.proofId }] }), /export_view_unavailable/);
    const publicPreview = await f.proofs.preview(f.actor, { id: randomUUID(), evidenceId: evidence.id });
    const publicProof = await f.proofs.publish(f.actor, await f.authorize(JSON.parse(publicPreview.payloadJson), 'proof.publish', { visibility: 'Public', purpose: 'public-profile' }));
    const publicTicket = await f.dataExport.create(other.actor, { id: randomUUID(), datasets: ['authorized-views'], views: [{ kind: 'proof', id: publicProof.proofId }] });
    const publicPage = await f.dataExport.page(other.actor, { id: publicTicket.id, dataset: 'authorized-views' });
    assert.deepEqual(publicPage.items[0].view, await f.proofs.get(other.actor, publicProof.proofId));
    assert.ok(!JSON.stringify(publicPage).includes(parent.title));
    await f.proofs.revoke(f.actor, publicProof.proofId);
    await assert.rejects(f.dataExport.page(other.actor, { id: publicTicket.id, dataset: 'authorized-views' }), /export_view_unavailable/);
    await f.proofs.revoke(f.actor, proof.proofId); await f.consents.revoke(f.actor, grant.consentId);
    await assert.rejects(f.cases.get(f.actor, parent.id));
    const specification = await host.readDataExport('specification'); assert.deepEqual(specification.datasets, exportDatasets);
    const ticket = await host.readDataExport('create');
    assert.deepEqual(await f.dataExport.create(f.actor, { id: ticket.id }), ticket);
    await assert.rejects(other.dataExport.page(other.actor, { id: ticket.id, dataset: 'identity' }), /not_found/);
    await (options.adminDatabase ?? f.db).query('UPDATE access_credentials SET scopes=$2::jsonb WHERE token_hash=$1', [other.actor.credentialHash, JSON.stringify(['binding'])]);
    await assert.rejects(other.dataExport.specification(other.actor), /access_denied/);
    assert.throws(() => f.dataExport.create(f.actor, { id: randomUUID(), subjectId: other.actor.subjectId }), /invalid_export_request/);
    rateLimitOnce = true;
    const first = await client.page({ id: ticket.id, dataset: 'case-events', limit: 1 }); assert.equal(first.items.length, 1); assert.ok(first.nextAfter); assert.equal(retries, 1);
    const second = await client.page({ id: ticket.id, dataset: 'case-events', after: first.nextAfter, limit: 1 });
    assert.notEqual(first.items[0].id, second.items[0].id);
    tamper = true; await assert.rejects(client.page({ id: ticket.id, dataset: 'identity' }), /mismatch/); tamper = false;
    const saved = await host.saveDataExport(ticket.id, temporary); assert.equal(saved.complete, true); assert.equal(saved.files, exportDatasets.length);
    const manifest = JSON.parse(await readFile(join(saved.directory, 'manifest.json'), 'utf8'));
    const all = [];
    for (const [name, hash] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(saved.directory, name)); assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
      all.push(bytes.toString());
    }
    const text = all.join('\n'); assert.ok(text.includes(parent.id)); assert.ok(!text.includes(foreign.id));
    assert.ok(!text.includes(other.actor.subjectId)); assert.ok(!text.includes(f.credential)); assert.ok(!text.includes(f.actor.credentialHash));
    assert.ok(!text.includes('token_hash')); assert.ok(!text.includes('credential_hash'));
    const proofs = (await readFile(join(saved.directory, 'proofs.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    const historical = proofs.find(row => row.id === proof.proofId);
    assert.equal(historical.signed, proof.signed); assert.ok(historical.revoked_at);
    const identities = (await readFile(join(saved.directory, 'identity.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(identities[0].id, f.actor.subjectId); assert.deepEqual(identities[0].genesis_proof, f.genesis.genesisProof);
    await host.readDataExport('revoke', { id: ticket.id });
    await assert.rejects(f.dataExport.page(f.actor, { id: ticket.id, dataset: 'identity' }), /export_expired/);
    const selected = await f.dataExport.create(f.actor, { id: randomUUID(), datasets: ['identity'] });
    await assert.rejects(f.dataExport.page(f.actor, { id: selected.id, dataset: 'cases' }), /dataset_denied/);
    const admin = options.adminDatabase ?? f.db;
    await admin.query('UPDATE data_exports SET expires_at=$2 WHERE id=$1', [selected.id, new Date((f.now - 1) * 1000).toISOString()]);
    await assert.rejects(f.dataExport.page(f.actor, { id: selected.id, dataset: 'identity' }), /export_expired/);
    const readCount = (await f.db.query('SELECT count(*) FROM data_export_reads WHERE subject_id=$1', [f.actor.subjectId])).rows[0].count;
    const cleaned = await cleanupExpiredExports(options.workerDatabase ?? f.db, new Date(f.now * 1000)); assert.ok(cleaned.removed >= 2);
    assert.equal((await f.db.query('SELECT count(*) FROM data_export_reads WHERE subject_id=$1', [f.actor.subjectId])).rows[0].count, readCount);
    const canceled = await host.readDataExport('create', { datasets: ['identity'] });
    host.disconnect(); await assert.rejects(client.page({ id: canceled.id, dataset: 'identity' }), /authorization|Authorization/);
    await admin.query('UPDATE bindings SET revoked_at=now() WHERE id=$1', [f.actor.bindingId]);
    await assert.rejects(f.dataExport.page(f.actor, { id: canceled.id, dataset: 'identity' }), /access_denied/);
    assert.ok((await readdir(temporary)).length === 1);
    return { datasets: exportDatasets.length, ownData: true, revokedProofPreservedAsHistorical: true, localFilesVerified: true, cleanupPreservesReadAudit: true };
  } finally {
    sessions.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
    if (!database) await f.db.close(); await rm(temporary, { recursive: true, force: true });
  }
}
