import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDeviceMaterial, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { prepareTrustPackage, sealTrustPackage, verifyTrustPackage } from '../src/trust-package.mjs';
import { trustHash, trustCanonical } from '../src/shared/trust-package-crypto.mjs';

async function identity() {
  const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem });
  return { material, identity: { subjectId: genesis.id, genesisProof: genesis.genesisProof, events: [], authority: null, checkedAt: Math.floor(Date.now() / 1000) },
    keyId: await trustHash(material.publicKeyPem), epoch: 0 };
}
async function seal(data, owner) {
  const preview = await prepareTrustPackage(data);
  return sealTrustPackage(preview, await signIdentityPayload(preview.manifestJson, owner.material.privateKey, { type: preview.signatureType }));
}
test('newcomer self-assertion exports readable canonical package, separate verifier imports offline, tampering and expiry stay distinct', async () => {
  const owner = await identity(), now = Math.floor(Date.now() / 1000);
  const data = { identity: owner.identity, keyId: owner.keyId, epoch: 0, audience: { kind: 'public' }, issuedAt: now, expiresAt: now + 3600,
    claims: [{ id: randomUUID(), text: 'I can help review this kind of parser; no verified history yet.', authority: 'self-asserted', capabilityVerified: false }], sources: [] };
  const container = await seal(data, owner), verified = await verifyTrustPackage(container);
  assert.equal(verified.integrity, 'valid'); assert.equal(verified.capabilityVerified, false); assert.equal(verified.currentRevocationChecked, false);
  assert.match(verified.summary, /未验证/); assert.equal(verified.importedBusinessFacts, 0);
  assert.deepEqual(await prepareTrustPackage(data), await prepareTrustPackage(data), 'same content and selected time keep stable package ID');
  const tampered = structuredClone(container); tampered.files['summary.md'] += '\nVerified expert'; await assert.rejects(verifyTrustPackage(tampered), /file changed/);
  const bad = structuredClone(container); bad.signature = bad.signature.slice(0, -8) + 'AAAAAAAA'; await assert.rejects(verifyTrustPackage(bad));
  const expired = await verifyTrustPackage(container, { now: now + 4000 }); assert.equal(expired.temporalState, 'expired'); assert.equal(expired.signature, 'valid-for-included-control-history');
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-trust-verifier-'));
  try {
    const file = join(directory, 'package.json'); await writeFile(file, JSON.stringify(container));
    const process = await promisify(execFile)(globalThis.process.execPath, ['packages/galaxy-official/scripts/verify-trust-package.mjs', file], { windowsHide: true });
    const report = JSON.parse(process.stdout); assert.equal(report.integrity, 'valid'); assert.equal(report.networkRequests, 0); assert.equal(report.businessWrites, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('copy needs independently signed exact author permission; audience and original signature hashes cannot expand; outer validity does not repair bad inner signature', async () => {
  const author = await identity(), holder = await identity(), now = Math.floor(Date.now() / 1000), endpoint = 'https://selected.example';
  const bodyText = '{"kind":"participant-report","summary":"Synthetic authored observation"}';
  const source = { ref: { endpoint, kind: 'case-event', id: randomUUID(), version: 1, caseId: randomUUID() }, authorId: author.identity.subjectId,
    sourceHash: await trustHash(bodyText), authority: 'participant-reported', sourceState: 'current', checkedAt: now, mode: 'copy', bodyText,
    signatureEvidence: 'not-provided', referenceBasis: 'explicit-trust-permission', limitations: ['Self-reported observation; not proof of success.'] };
  const audience = { kind: 'subjects', subjectIds: [holder.identity.subjectId] };
  const data = { identity: holder.identity, keyId: holder.keyId, epoch: 0, audience, issuedAt: now, expiresAt: now + 3600, claims: [], sources: [source] };
  await assert.rejects(prepareTrustPackage(data), /separate reproduction permission/);
  const grant = { version: 1, type: 'galaxy-trust-source-permission', id: randomUUID(), operationId: randomUUID(), subjectId: author.identity.subjectId,
    bindingId: randomUUID(), endpoint, kind: 'grant', grantee: holder.identity.subjectId, source: source.ref, sourceHash: source.sourceHash, originalSignatureHash: null,
    audience, purpose: 'trust-package-only', permission: 'copy-exact-authored-record', trainingAllowed: false, onlineAccessGranted: false,
    sourceAuthorDeclaration: 'I authorize the exact authored record; no third-party source bodies are included', keyId: author.keyId,
    epoch: 0, chainHead: null, issuedAt: now, expiresAt: now + 7200 };
  source.permission = { signed: await signIdentityPayload(trustCanonical(grant), author.material.privateKey, { type: 'galaxy-trust-source-permission-v1+jws' }),
    identity: author.identity, status: 'active', checkedAt: now };
  const container = await seal(data, holder), good = await verifyTrustPackage(container);
  assert.equal(good.sources[0].reproductionPermission.status, 'signature-and-scope-valid');
  await assert.rejects(prepareTrustPackage({ ...data, audience: { kind: 'public' } }), /permission unavailable/);
  const duplicate = await prepareTrustPackage({ ...data, sources: [source, source] }); assert.equal(duplicate.sourceCount, 1);
  await assert.rejects(prepareTrustPackage({ ...data, sources: [source, { ...source, sourceHash: 'a'.repeat(64) }] }), /Conflicting/);
  source.originalSignature = { profile: 'galaxy-consent', signed: 'malformed-inner-signature', identity: author.identity };
  await assert.rejects(prepareTrustPackage(data), /permission unavailable/);
  source.signatureEvidence = 'original-signature'; grant.originalSignatureHash = await trustHash(source.originalSignature.signed);
  source.permission.signed = await signIdentityPayload(trustCanonical(grant), author.material.privateKey, { type: 'galaxy-trust-source-permission-v1+jws' });
  const invalidInner = await verifyTrustPackage(await seal(data, holder));
  assert.equal(invalidInner.integrity, 'valid'); assert.equal(invalidInner.sources[0].originalSignature.status, 'invalid'); assert.equal(invalidInner.capabilityVerified, false);
});
