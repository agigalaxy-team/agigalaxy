import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createCaseDraft,
  createDisclosurePlan,
  createLocalProofDraft,
  exportLocalData,
  getGalaxyIntegrationStatus,
  initializeGalaxyIntegration,
  initializeLocalGalaxyId,
  resetGalaxyIntegration,
  revokeConsentGrant,
  issueConsentGrant,
} from '../src/local-store.mjs';
import { parseGalaxyGuid } from '../src/galaxy-guid.mjs';

test('a local Galaxy ID creates an explicit consent-gated Local Proof Draft without exporting private material', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'galaxy-core-test-'));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));

  const initial = await initializeLocalGalaxyId(dataDir);
  assert.match(initial.identity.id, /^GUID[0-9A-HJKMNPQRSTVWXYZ]{28}$/);
  assert.equal(initial.identity.id.length, 32);
  assert.equal(initial.identity.idFormat, 'guid-32-v1');
  assert.deepEqual(parseGalaxyGuid(initial.identity.id).origin, {
    key: 'local', title: 'Local standalone client',
  });
  assert.equal(initial.identity.localOnly, true);

  const caseDraft = await createCaseDraft(dataDir, {
    title: 'TypeScript build fails after a dependency update',
    failureSummary: 'The type checker reports an incompatible API change after several attempts.',
    attemptedApproaches: ['Pinned the package', 'Rebuilt the lockfile'],
  });
  const disclosure = await createDisclosurePlan(dataDir, {
    caseId: caseDraft.id,
    recipient: 'selected-future-resolver',
    purpose: 'Private review of this local Coding Case',
    include: ['failure_summary', 'attempt_metadata'],
    expiresInHours: 12,
  });
  assert.deepEqual(disclosure.exclude, ['secrets', 'env', 'tokens', 'credentials', 'unselected_source']);

  const grant = await issueConsentGrant(dataDir, disclosure.id);
  const proof = await createLocalProofDraft(dataDir, {
    caseId: caseDraft.id,
    consentGrantId: grant.id,
    verificationNote: 'A local draft exists; independent verification is still required.',
  });
  assert.equal(proof.visibility, 'local-only');
  assert.equal(proof.status, 'draft');

  const exported = await exportLocalData(dataDir);
  assert.equal(exported.identity.id, initial.identity.id);
  assert.ok(!JSON.stringify(exported).includes('PRIVATE KEY'));
  assert.deepEqual(exported.excluded, [
    'galaxy-id-private-key.pem',
    'raw source files',
    'environment variables',
    'tokens',
    'credentials',
  ]);

  await revokeConsentGrant(dataDir, grant.id);
  await assert.rejects(
    () => createLocalProofDraft(dataDir, {
      caseId: caseDraft.id,
      consentGrantId: grant.id,
      verificationNote: 'This must not be created after revoke.',
    }),
    /active Consent Grant/,
  );
});

test('a pre-Integration-Pack local identity migrates from legacy filenames without changing its ID', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'galaxy-core-legacy-test-'));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));

  const legacyIdentity = {
    version: 1,
    id: 'gxy_n1_legacyidentitypreserved000001',
    publicKeyFingerprint: 'legacy:fingerprint',
    keyAlgorithm: 'Ed25519',
    createdAt: '2026-08-30T00:00:00.000Z',
    localOnly: true,
    transport: 'none',
  };
  await writeFile(join(dataDir, 'node.json'), JSON.stringify(legacyIdentity));
  await writeFile(join(dataDir, 'node-private-key.pem'), 'legacy private key');
  await writeFile(join(dataDir, 'node-public-key.pem'), 'legacy public key');
  await writeFile(join(dataDir, 'local-state.json'), JSON.stringify({
    version: 1,
    cases: [],
    disclosurePlans: [],
    consentGrants: [],
    localProofDrafts: [],
    auditEvents: [],
  }));

  const migrated = await initializeLocalGalaxyId(dataDir);
  assert.equal(migrated.identity.id, legacyIdentity.id);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'galaxy-id.json'), 'utf8')), legacyIdentity);
  await assert.rejects(() => readFile(join(dataDir, 'node.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(() => readFile(join(dataDir, 'local-state.json'), 'utf8'), { code: 'ENOENT' });
  assert.ok(JSON.parse(await readFile(join(dataDir, 'galaxy-local-state.json'), 'utf8')).integration === null);
});

test('reinitialize cleanup removes only Galaxy-managed files and allows a fresh ID', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'galaxy-reset-test-'));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));

  await writeFile(join(dataDir, 'keep-me.txt'), 'unrelated local file');
  const first = await initializeGalaxyIntegration(dataDir, { initializationPath: 'personal-galaxy', source: 'test' });
  const before = await getGalaxyIntegrationStatus(dataDir);
  assert.equal(before.initialized, true);
  assert.equal(before.galaxyId.id, first.galaxyId.id);

  const reset = await resetGalaxyIntegration(dataDir);
  assert.ok(reset.removedFiles.includes('galaxy-id.json'));
  assert.ok(reset.removedFiles.includes('galaxy-id-private-key.pem'));
  assert.equal(await readFile(join(dataDir, 'keep-me.txt'), 'utf8'), 'unrelated local file');
  await assert.rejects(() => readFile(join(dataDir, 'galaxy-id.json'), 'utf8'), { code: 'ENOENT' });

  const after = await getGalaxyIntegrationStatus(dataDir);
  assert.equal(after.initialized, false);
  assert.equal(after.galaxyId, null);
  const fresh = await initializeGalaxyIntegration(dataDir, { initializationPath: 'personal-galaxy', source: 'test' });
  assert.notEqual(fresh.galaxyId.id, first.galaxyId.id);
});
