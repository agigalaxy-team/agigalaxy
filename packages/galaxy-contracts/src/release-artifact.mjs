import { CompactSign, compactVerify, decodeProtectedHeader } from 'jose';
import { z } from 'zod';
import { createHash } from 'node:crypto';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const timestamp = z.number().int().nonnegative();
const common = {
  version: z.literal(1),
  publisher: z.string().min(1).max(200), purpose: z.enum(['local-validation', 'release-candidate']),
  issuedAt: timestamp, expiresAt: timestamp,
};
const packageSchema = (name, prefix, scopedDependencies = false) => z.object({ name: z.literal(name), version: z.string().regex(/^\d+\.\d+\.\d+$/),
    filename: z.string().regex(new RegExp(`^${prefix}-\\d+\\.\\d+\\.\\d+\\.tgz$`)), sha256: hash,
    bytes: z.number().int().positive().max(64 * 1024 * 1024),
    exports: z.array(z.string().regex(/^\.\/[a-z/-]+$/)).min(1).max(64),
    dependencies: z.record(z.string().regex(scopedDependencies ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/ : /^[a-z][a-z0-9.-]*$/), z.string().regex(/^\d+\.\d+\.\d+$/)),
    lockSha256: hash, sourceHashesSha256: hash,
  }).strict();
const schema = z.discriminatedUnion('kind', [z.object({ ...common, kind: z.literal('galaxy-client-release'),
  package: packageSchema('@galaxy/client', 'galaxy-client'),
  conformance: z.object({ profile: z.literal('galaxy-conformance/2'), reportSha256: hash,
    sourceSha256: hash, suiteSha256: hash, scope: z.literal('local-source-tests') }).strict(),
}).strict(), z.object({ ...common, kind: z.literal('galaxy-native-host-release'),
  package: packageSchema('@galaxy/native-host', 'galaxy-native-host'),
  hostAcceptance: z.object({ profile: z.literal('galaxy-native-host/1'), reportSha256: hash,
    sourceSha256: hash, artifactsSha256: hash, scope: z.literal('real-host-local-fixtures') }).strict(),
}).strict(), z.object({ ...common, kind: z.literal('galaxy-native-client-release'),
  package: packageSchema('@galaxy/native-client', 'galaxy-native-client', true),
  protocolAcceptance: z.object({ profile: z.literal('galaxy-native-client/1'), reportSha256: hash,
    sourceSha256: hash, artifactsSha256: hash, scope: z.literal('local-stdio-http-fixtures'),
    actualHostAcceptance: z.literal(false) }).strict(),
}).strict(), z.object({ ...common, kind: z.literal('galaxy-native-go-release'),
  package: packageSchema('@galaxy/native-go-candidate', 'galaxy-native-go', true),
  protocolAcceptance: z.object({ profile: z.literal('galaxy-native-go/1'), reportSha256: hash,
    sourceSha256: hash, artifactsSha256: hash, scope: z.literal('candidate-package-integrity'),
    actualHostAcceptance: z.literal(false) }).strict(),
}).strict()]).superRefine((value, context) => {
  if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 30 * 86400)
    context.addIssue({ code: 'custom', message: 'Release validity must be at most 30 days.' });
  const prefix = {'galaxy-client-release':'galaxy-client','galaxy-native-host-release':'galaxy-native-host','galaxy-native-client-release':'galaxy-native-client','galaxy-native-go-release':'galaxy-native-go'}[value.kind];
  if (value.package.filename !== `${prefix}-${value.package.version}.tgz`
    || new Set(value.package.exports).size !== value.package.exports.length)
    context.addIssue({ code: 'custom', message: 'Release package metadata mismatch.' });
});

// Reuse standard JWS/Ed25519. Keys come from the caller; there is no key file,
// network trust discovery, embedded self-trust, install or publication here.
export async function signRelease(manifest, { privateKey, kid }) {
  const data = schema.parse(manifest);
  if (typeof kid !== 'string' || !kid || kid.length > 200) throw new Error('Release key id required.');
  return new CompactSign(Buffer.from(JSON.stringify(data)))
    .setProtectedHeader({ alg: 'EdDSA', typ: 'galaxy-release+jws', kid }).sign(privateKey);
}

export async function verifyRelease(signed, { trustedKeys, publisher, artifact, report,
  expectedPackage = '@galaxy/client', now = Math.floor(Date.now() / 1000) }) {
  if (typeof signed !== 'string' || signed.length > 65536 || !Number.isSafeInteger(now)) throw new Error('Invalid release input.');
  const header = decodeProtectedHeader(signed);
  if (header.alg !== 'EdDSA' || header.typ !== 'galaxy-release+jws' || typeof header.kid !== 'string'
    || Object.keys(header).some(name => !['alg', 'typ', 'kid'].includes(name))) throw new Error('Unexpected release header.');
  const trust = trustedKeys.get(header.kid);
  if (!trust || trust.revoked || !Number.isSafeInteger(trust.notBefore) || !Number.isSafeInteger(trust.notAfter)
    || now < trust.notBefore || now >= trust.notAfter) throw new Error('Release signing key unavailable.');
  const verified = await compactVerify(signed, trust.publicKey, { algorithms: ['EdDSA'] });
  const manifest = schema.parse(JSON.parse(Buffer.from(verified.payload).toString('utf8')));
  if (manifest.package.name !== expectedPackage || manifest.publisher !== publisher || now < manifest.issuedAt || now >= manifest.expiresAt
    || manifest.issuedAt < trust.notBefore || manifest.expiresAt > trust.notAfter)
    throw new Error('Release publisher or validity mismatch.');
  if (!Buffer.isBuffer(artifact) || artifact.length !== manifest.package.bytes || sha(artifact) !== manifest.package.sha256
    || !Buffer.isBuffer(report) || sha(report) !== (manifest.conformance ?? manifest.hostAcceptance ?? manifest.protocolAcceptance).reportSha256)
    throw new Error('Release artifact or report mismatch.');
  return { manifest, kid: header.kid, signatureVerified: true, currentRevocationChecked: false,
    verificationScope: 'caller-pinned-key-and-exact-artifact', publicationReady: false };
}
