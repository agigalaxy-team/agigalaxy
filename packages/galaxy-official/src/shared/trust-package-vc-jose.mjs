import { CompactSign, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import * as z from 'zod/v4';
import { verifyTrustPackage } from '../trust-package.mjs';
import { trustCanonical, trustHash, trustSubject, verifyTrustIdentity } from './trust-package-crypto.mjs';
import { trustContainerSchema, trustManifestSchema } from './trust-package-schema.mjs';
import { fromBase64Url } from '../../../galaxy-core/src/domain/identity-material.mjs';

export const trustVcJoseProfile = 'galaxy-trust-vc-jose/v1';
export const trustVcJoseMediaType = 'application/vc+jwt';
const context = 'https://www.w3.org/ns/credentials/v2';
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const error = code => Object.assign(new Error(code), { code });
const require = (condition, code) => { if (!condition) throw error(code); };
const same = (left, right) => trustCanonical(left) === trustCanonical(right);
const seconds = z.number().int().nonnegative().max(8640000000000);
const bundleSchema = z.strictObject({ format: z.literal(trustVcJoseProfile), mediaType: z.literal(trustVcJoseMediaType),
  credential: z.string().min(1).max(800000), package: trustContainerSchema });

// A reversible URI representation of the existing GUID, not a new DID,
// remotely resolved account, official issuer, or identity migration.
export const trustSubjectUri = subjectId => 'urn:galaxy:subject:' + trustSubject.parse(subjectId);
const credentialId = (packageId, issuedAt) => `urn:galaxy:trust-package:${packageId}:vc-jose:${issuedAt}`;
const date = value => new Date(seconds.parse(value) * 1000).toISOString();
const base64 = bytes => btoa(String.fromCharCode(...bytes));
async function resource(container) {
  // The companion preserves every original signed string. Its transport JSON
  // order is irrelevant; this profile fixes canonical JSON for its resource.
  const text = trustCanonical(container), hash = await trustHash(text);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-384', encode(text)));
  return { id: 'urn:sha256:' + hash, mediaType: 'application/json', digestSRI: 'sha384-' + base64(bytes) };
}
async function packageDetails(input, now) {
  const container = trustContainerSchema.parse(input), result = await verifyTrustPackage(container, { now });
  const manifest = trustManifestSchema.parse(JSON.parse(container.manifestJson));
  const identity = JSON.parse(container.files['identity.json']), control = await verifyTrustIdentity(identity);
  const key = control.devices.find(value => value.keyId === manifest.keyId && value.epoch === manifest.epoch);
  require(key, 'trust_vc_signer_mismatch');
  return { container, manifest, result, key };
}
function credentialFor(manifest, summary, related, issuedAt) {
  const issuer = trustSubjectUri(manifest.subjectId), id = credentialId(manifest.packageId, issuedAt);
  // Only terms in the permanent VCDM 2.0 base context. The selected readable
  // claim remains a description; the exact original package is a separately
  // integrity-bound local companion, not reissued third-party credentials.
  return { '@context': [context], type: ['VerifiableCredential'], id,
    issuer, credentialSubject: { id: issuer, description: summary },
    name: 'Self-issued attestation of a selected Galaxy trust package',
    description: 'The identified subject signs this selected package. This does not certify its contained claims, institutional authority, capability, current permission, or current revocation status.',
    validFrom: date(manifest.issuedAt), validUntil: date(manifest.expiresAt), relatedResource: [related],
    iss: issuer, sub: issuer, iat: issuedAt, exp: manifest.expiresAt,
    ...(manifest.audience.kind === 'subjects' ? { aud: manifest.audience.subjectIds.map(trustSubjectUri) } : {}) };
}

export async function prepareTrustPackageVcJose(input, { now = Math.floor(Date.now() / 1000) } = {}) {
  seconds.parse(now);
  const { container, manifest, result } = await packageDetails(input, now);
  require(manifest.issuedAt <= now && manifest.expiresAt > now, 'trust_vc_package_not_current');
  // This is a new disclosure. An expired/invalid reproduction license cannot
  // be repaired by another outer signature over an old local package.
  require(result.sources.every(source => source.reproductionPermission.status !== 'invalid-or-expired'), 'trust_vc_reproduction_permission_unavailable');
  const credential = credentialFor(manifest, container.files['summary.md'], await resource(container), now);
  const protectedHeader = { alg: 'Ed25519', typ: 'vc+jwt', cty: 'vc', kid: manifest.keyId };
  return structuredClone({ profile: trustVcJoseProfile, mediaType: trustVcJoseMediaType, package: container,
    credential, payloadJson: trustCanonical(credential), protectedHeader, packageId: manifest.packageId,
    issuerAuthority: 'self-issued-package-attestation', currentStatus: 'unknown', capabilityVerified: false,
    remotePublished: false, audienceEncrypted: false });
}

async function validatePreview(preview, now) {
  const issuedAt = seconds.parse(preview?.credential?.iat);
  require(issuedAt <= now + 300, 'trust_vc_signature_time_future');
  const rebuilt = await prepareTrustPackageVcJose(preview.package, { now: issuedAt });
  require(same(rebuilt, preview), 'trust_vc_preview_changed');
  require(preview.credential.exp > now, 'trust_vc_package_not_current');
  return rebuilt;
}

// Purpose-specific signing; callers pass their existing local CryptoKey.
// No private key is exported, discovered, or accepted from the package.
export async function signTrustPackageVcJose(preview, privateKey, { now = Math.floor(Date.now() / 1000) } = {}) {
  const checked = await validatePreview(preview, seconds.parse(now));
  return new CompactSign(encode(checked.payloadJson)).setProtectedHeader(checked.protectedHeader).sign(privateKey);
}

export async function sealTrustPackageVcJose(preview, signature, { now = Math.floor(Date.now() / 1000) } = {}) {
  const checked = await validatePreview(preview, seconds.parse(now)), manifest = JSON.parse(checked.package.manifestJson);
  const details = await packageDetails(checked.package, now), issuer = trustSubjectUri(manifest.subjectId);
  const bundle = bundleSchema.parse({ format: trustVcJoseProfile, mediaType: trustVcJoseMediaType, credential: signature, package: checked.package });
  // A signing self-check uses the key already verified against this user's
  // ordinary package. Receiver trust still requires an independently chosen pin.
  await verifyTrustPackageVcJose(bundle, { now, trustedIssuers: new Map([[issuer,
    new Map([[manifest.keyId, { publicKeyPem: details.key.publicKey }]])]]),
    ...(manifest.audience.kind === 'subjects' ? { audience: manifest.audience.subjectIds[0] } : {}) });
  return structuredClone(bundle);
}

/** @param {unknown} input @param {{trustedIssuers?:Map<string,Map<string,{publicKeyPem:string,revoked?:boolean,notBefore?:number,notAfter?:number}>>,expectedIssuer?:string,expectedSubject?:string,audience?:string,now?:number}} [options] */
export async function verifyTrustPackageVcJose(input, { trustedIssuers, expectedIssuer, expectedSubject, audience,
  now = Math.floor(Date.now() / 1000) } = {}) {
  seconds.parse(now);
  if (typeof input === 'string') require(input.length <= 6500000, 'trust_vc_package_limit');
  const bundle = bundleSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
  const parts = bundle.credential.split('.');
  require(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)), 'trust_vc_compact_encoding');
  const header = decodeProtectedHeader(bundle.credential);
  require(Object.keys(header).sort().join(',') === 'alg,cty,kid,typ' && header.alg === 'Ed25519'
    && header.typ === 'vc+jwt' && header.cty === 'vc' && /^[a-f0-9]{64}$/.test(header.kid), 'trust_vc_header_profile');
  // Read issuer only as an untrusted lookup hint. No URL/context/key retrieval.
  require(decode(fromBase64Url(parts[0])) === JSON.stringify(header), 'trust_vc_header_encoding');
  fromBase64Url(parts[2]);
  const payloadText = decode(fromBase64Url(parts[1])), untrusted = JSON.parse(payloadText);
  require(payloadText === trustCanonical(untrusted), 'trust_vc_payload_encoding');
  const issuer = untrusted.issuer, selected = trustedIssuers?.get?.(issuer)?.get?.(header.kid);
  require(selected?.publicKeyPem, 'trust_vc_issuer_pin_required');
  const pin = structuredClone(selected);
  require(pin.revoked !== true, 'trust_vc_issuer_pin_revoked');
  const checked = await jwtVerify(bundle.credential, await importSPKI(pin.publicKeyPem, 'Ed25519'),
    { algorithms: ['Ed25519'], typ: 'vc+jwt', issuer, currentDate: new Date(now * 1000) });
  const vc = checked.payload;
  require(same(vc['@context'], [context]) && same(vc.type, ['VerifiableCredential']), 'trust_vc_document_profile');
  const { container, manifest, result, key } = await packageDetails(bundle.package, now);
  require(pin.publicKeyPem === key.publicKey && await trustHash(pin.publicKeyPem) === header.kid && header.kid === manifest.keyId, 'trust_vc_issuer_key_mismatch');
  require(Number.isSafeInteger(vc.iat) && vc.iat >= manifest.issuedAt && vc.iat <= now + 300 && vc.iat < manifest.expiresAt,
    'trust_vc_signature_time_mismatch');
  if (pin.notBefore !== undefined) require(Number.isSafeInteger(pin.notBefore) && pin.notBefore <= vc.iat, 'trust_vc_issuer_pin_interval');
  if (pin.notAfter !== undefined) require(Number.isSafeInteger(pin.notAfter) && pin.notAfter >= vc.iat, 'trust_vc_issuer_pin_interval');
  const expected = credentialFor(manifest, container.files['summary.md'], await resource(container), vc.iat);
  require(same(vc, expected), 'trust_vc_package_credential_mismatch');
  if (expectedIssuer !== undefined) require(vc.issuer === expectedIssuer, 'trust_vc_expected_issuer_mismatch');
  if (expectedSubject !== undefined) require(vc.credentialSubject.id === trustSubjectUri(expectedSubject), 'trust_vc_expected_subject_mismatch');
  require(manifest.issuedAt <= now && manifest.expiresAt > now, 'trust_vc_package_not_current');
  if (manifest.audience.kind === 'subjects') {
    require(audience !== undefined, 'trust_vc_audience_required');
    require(manifest.audience.subjectIds.includes(trustSubject.parse(audience)), 'trust_vc_audience_mismatch');
  } else if (audience !== undefined) trustSubject.parse(audience);
  // Return checked metadata and the readable selected statement. No automatic
  // import into facts, permission grants, issuer registry or capability rank.
  return { profile: trustVcJoseProfile, mediaType: trustVcJoseMediaType, integrity: 'valid',
    issuer: vc.issuer, subjectId: manifest.subjectId, packageId: manifest.packageId,
    issuerAuthority: 'self-issued-package-attestation', issuerPinSelected: true,
    signature: 'valid-for-selected-issuer-key-and-included-control-history', temporalState: 'within-declared-interval',
    issuedAt: vc.iat, validFrom: vc.validFrom, validUntil: vc.validUntil, audience: manifest.audience,
    currentStatus: 'unknown', currentRevocationChecked: false, capabilityVerified: false,
    onlineAccessGranted: false, audienceEncrypted: false, ordinaryPackage: result,
    importedBusinessFacts: 0, networkRequests: 0 };
}
