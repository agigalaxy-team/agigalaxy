import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, verify as verifySignature } from 'node:crypto';
import { CompactSign, decodeProtectedHeader } from 'jose';
import { createDeviceMaterial, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { prepareTrustPackage, sealTrustPackage } from '../src/trust-package.mjs';
import { trustCanonical, trustHash } from '../src/shared/trust-package-crypto.mjs';
import { prepareTrustPackageVcJose, signTrustPackageVcJose, sealTrustPackageVcJose, verifyTrustPackageVcJose,
  trustSubjectUri } from '../src/shared/trust-package-vc-jose.mjs';

export async function vcFixture({ audience, sources = [] } = {}) {
  const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem });
  const now = Math.floor(Date.now() / 1000), identity = { subjectId: genesis.id, genesisProof: genesis.genesisProof, events: [], authority: null, checkedAt: now };
  const keyId = await trustHash(material.publicKeyPem), input = { identity, keyId, epoch: 0, audience: audience ?? { kind: 'public' },
    issuedAt: now, expiresAt: now + 3600, sources,
    claims: [{ id: randomUUID(), text: 'I report experience with this parser; it has not been independently verified.', authority: 'self-asserted', capabilityVerified: false }] };
  const ordinary = await prepareTrustPackage(input, { now });
  const container = await sealTrustPackage(ordinary, await signIdentityPayload(ordinary.manifestJson, material.privateKey, { type: ordinary.signatureType }));
  const issuer = trustSubjectUri(identity.subjectId), pins = new Map([[issuer, new Map([[keyId, { publicKeyPem: material.publicKeyPem }]])]]);
  const preview = await prepareTrustPackageVcJose(container, { now });
  const bundle = await sealTrustPackageVcJose(preview, await signTrustPackageVcJose(preview, material.privateKey), { now });
  return { material, identity, keyId, now, input, container, preview, bundle, pins, issuer };
}
const verify = (f, options = {}) => verifyTrustPackageVcJose(f.bundle, { trustedIssuers: f.pins, now: f.now, ...options });

test('VC2 JOSE uses the standard payload and actual self issuer; independent Node crypto verifies exact JWS without changing the ordinary package', async () => {
  const f = await vcFixture(), original = trustCanonical(f.container), [header, payload, signature] = f.bundle.credential.split('.');
  assert.equal(verifySignature(null, Buffer.from(header + '.' + payload), f.material.publicKeyPem, Buffer.from(signature, 'base64url')), true);
  const vc = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(vc['@context'], ['https://www.w3.org/ns/credentials/v2']);
  assert.ok(vc.type.includes('VerifiableCredential')); assert.equal(vc.issuer, f.issuer); assert.equal(vc.iss, vc.issuer);
  assert.equal(vc.credentialSubject.id, f.issuer); assert.equal(vc.sub, vc.credentialSubject.id);
  assert.equal(vc.vc, undefined); assert.equal(vc.vp, undefined); assert.equal(vc.credentialStatus, undefined);
  assert.equal(vc.credentialSubject.description, f.container.files['summary.md']);
  assert.match(vc.relatedResource[0].digestSRI, /^sha384-/);
  assert.deepEqual(decodeProtectedHeader(f.bundle.credential), { alg: 'Ed25519', typ: 'vc+jwt', cty: 'vc', kid: f.keyId });
  const result = await verify(f, { expectedIssuer: f.issuer, expectedSubject: f.identity.subjectId });
  assert.equal(result.integrity, 'valid'); assert.equal(result.issuerAuthority, 'self-issued-package-attestation');
  assert.equal(result.currentStatus, 'unknown'); assert.equal(result.capabilityVerified, false); assert.equal(result.networkRequests, 0);
  assert.equal(result.importedBusinessFacts, 0); assert.equal(trustCanonical(f.bundle.package), original); assert.equal(trustCanonical(f.container), original);
});

test('credential tampering, detached package mismatch, and an unrelated signing key cannot hide behind the original package signature', async () => {
  const f = await vcFixture(), changed = structuredClone(f.bundle);
  const [head, body, sig] = changed.credential.split('.'), data = JSON.parse(Buffer.from(body, 'base64url'));
  data.credentialSubject.description += ' Certified professional.';
  changed.credential = head + '.' + Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + sig;
  await assert.rejects(verifyTrustPackageVcJose(changed, { trustedIssuers: f.pins, now: f.now }));
  const other = await vcFixture(); changed.credential = f.bundle.credential; changed.package = other.container;
  await assert.rejects(verifyTrustPackageVcJose(changed, { trustedIssuers: f.pins, now: f.now }), /mismatch/);
  await assert.rejects(sealTrustPackageVcJose(f.preview, await signTrustPackageVcJose(f.preview, other.material.privateKey), { now: f.now }));
});

test('receiver must select issuer pins and exact recipient scope; wrong issuer, subject, audience, revoked pin, and expiry are rejected', async () => {
  const recipient = (await vcFixture()).identity.subjectId;
  const f = await vcFixture({ audience: { kind: 'subjects', subjectIds: [recipient] } });
  await assert.rejects(verifyTrustPackageVcJose(f.bundle, { now: f.now }), /issuer_pin_required/);
  await assert.rejects(verify(f), /audience_required/);
  assert.equal((await verify(f, { audience: recipient })).integrity, 'valid');
  await assert.rejects(verify(f, { audience: f.identity.subjectId }), /audience/);
  await assert.rejects(verify(f, { audience: recipient, expectedIssuer: trustSubjectUri(recipient) }), /issuer/);
  await assert.rejects(verify(f, { audience: recipient, expectedSubject: recipient }), /subject/);
  const revoked = new Map([[f.issuer, new Map([[f.keyId, { publicKeyPem: f.material.publicKeyPem, revoked: true }]])]]);
  await assert.rejects(verify(f, { audience: recipient, trustedIssuers: revoked }), /issuer_pin_revoked/);
  await assert.rejects(verify(f, { audience: recipient, now: f.now + 3601 }));
  await assert.rejects(prepareTrustPackageVcJose(f.container, { now: f.now + 3601 }), /package_not_current/);
});

test('a correctly signed credential still rejects foreign subject or audience, algorithm/header substitution and arbitrary contexts; no key/context URL is fetched', async () => {
  const f = await vcFixture(), originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('Unexpected network'); };
  const resign = async (payload, header = f.preview.protectedHeader) => ({ ...f.bundle,
    credential: await new CompactSign(new TextEncoder().encode(trustCanonical(payload))).setProtectedHeader(header).sign(f.material.privateKey) });
  try {
    const foreign = await vcFixture(), payload = structuredClone(f.preview.credential);
    payload.sub = payload.credentialSubject.id = foreign.issuer;
    await assert.rejects(verifyTrustPackageVcJose(await resign(payload), { trustedIssuers: f.pins, now: f.now }), /mismatch/);
    const aud = { ...f.preview.credential, aud: [foreign.issuer] };
    await assert.rejects(verifyTrustPackageVcJose(await resign(aud), { trustedIssuers: f.pins, now: f.now, audience: foreign.identity.subjectId }), /mismatch/);
    const context = { ...f.preview.credential, '@context': ['https://www.w3.org/ns/credentials/v2', 'https://unselected.example/context'] };
    await assert.rejects(verifyTrustPackageVcJose(await resign(context), { trustedIssuers: f.pins, now: f.now }), /profile/);
    await assert.rejects(verifyTrustPackageVcJose(await resign(f.preview.credential, { ...f.preview.protectedHeader, jku: 'https://unselected.example/keys' }), { trustedIssuers: f.pins, now: f.now }), /header/);
    const [head, body] = f.bundle.credential.split('.');
    const unprotected = { ...f.bundle, credential: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(head, 'base64url')), alg: 'none' })).toString('base64url') + '.' + body + '.' };
    await assert.rejects(verifyTrustPackageVcJose(unprotected, { trustedIssuers: f.pins, now: f.now }));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
