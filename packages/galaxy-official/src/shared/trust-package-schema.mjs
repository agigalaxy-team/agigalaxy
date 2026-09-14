import * as z from 'zod/v4';
import { trustSubject } from './trust-package-crypto.mjs';
const hash = z.string().regex(/^[a-f0-9]{64}$/), second = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const trustOrigin = z.url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && u.origin === value && !u.username && !u.password; });
export const trustAudienceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('public') }),
  z.strictObject({ kind: z.literal('subjects'), subjectIds: z.array(trustSubject).min(1).max(100).refine(x => new Set(x).size === x.length) }),
]);
export const trustSourceRefSchema = z.strictObject({ endpoint: trustOrigin, kind: z.enum(['case-event', 'evidence', 'verification', 'proof', 'ci-proof-v2']),
  id: z.uuid(), version: z.number().int().positive(), caseId: z.uuid().optional(), taskId: z.uuid().optional() });
export const trustIdentitySchema = z.strictObject({ subjectId: trustSubject,
  genesisProof: z.strictObject({ version: z.literal(1), publicKeyPem: z.string().max(256), nonce: z.string().max(100) }),
  events: z.array(z.record(z.string(), z.unknown())).max(10000),
  authority: trustOrigin.nullable(), checkedAt: second,
});
export const trustPermissionSchema = z.strictObject({ version: z.literal(1), type: z.literal('galaxy-trust-source-permission'),
  id: z.uuid(), operationId: z.uuid(), subjectId: trustSubject, bindingId: z.uuid(), endpoint: trustOrigin,
  kind: z.enum(['grant', 'revoke']), grantee: trustSubject, source: trustSourceRefSchema, sourceHash: hash, originalSignatureHash: hash.nullable(),
  audience: trustAudienceSchema, purpose: z.literal('trust-package-only'),
  permission: z.literal('copy-exact-authored-record'), trainingAllowed: z.literal(false), onlineAccessGranted: z.literal(false),
  sourceAuthorDeclaration: z.literal('I authorize the exact authored record; no third-party source bodies are included'),
  keyId: hash, epoch: z.number().int().nonnegative(), chainHead: hash.nullable(), issuedAt: second, expiresAt: second,
}).refine(p => p.expiresAt > p.issuedAt && p.expiresAt <= p.issuedAt + 30 * 86400);
export const trustPermissionProofSchema = z.strictObject({ signed: z.string().max(30000), identity: trustIdentitySchema,
  status: z.enum(['active', 'revoked', 'expired', 'unknown']), checkedAt: second });
export const trustSourceSnapshotSchema = z.strictObject({ ref: trustSourceRefSchema, authorId: trustSubject, sourceHash: hash,
  authority: z.enum(['participant-reported', 'self-asserted', 'verification-record', 'ci-observation']),
  sourceState: z.enum(['current', 'superseded', 'expired', 'revoked', 'unavailable', 'unknown']), checkedAt: second,
  mode: z.enum(['reference', 'copy']), bodyText: z.string().max(48000).optional(),
  permission: trustPermissionProofSchema.optional(),
  originalSignature: z.strictObject({ profile: z.enum(['galaxy-consent', 'galaxy-proof', 'unrecognized']), signed: z.string().max(48000),
    identity: trustIdentitySchema.optional(), issuer: trustOrigin.optional(), keyId: z.string().max(160).optional() }).optional(),
  signatureEvidence: z.enum(['original-signature', 'legacy-verified-record', 'not-provided']),
  referenceBasis: z.enum(['own-authored-reference', 'public-reference', 'explicit-trust-permission']),
  limitations: z.array(z.string().max(500)).max(16),
});
export const trustClaimSchema = z.strictObject({ id: z.uuid(), text: z.string().trim().min(1).max(4000),
  authority: z.literal('self-asserted'), capabilityVerified: z.literal(false) });
export const trustPackageInputSchema = z.strictObject({ identity: trustIdentitySchema, keyId: hash, epoch: z.number().int().nonnegative(),
  audience: trustAudienceSchema, issuedAt: second, expiresAt: second,
  claims: z.array(trustClaimSchema).max(50), sources: z.array(trustSourceSnapshotSchema).max(50),
}).refine(p => p.claims.length + p.sources.length > 0 && p.expiresAt > p.issuedAt && p.expiresAt <= p.issuedAt + 30 * 86400);
export const trustManifestSchema = z.strictObject({ version: z.literal(1), type: z.literal('galaxy-readable-trust'), packageId: hash,
  subjectId: trustSubject, keyId: hash, epoch: z.number().int().nonnegative(), chainHead: hash.nullable(),
  audience: trustAudienceSchema, issuedAt: second, expiresAt: second,
  files: z.array(z.strictObject({ path: z.enum(['summary.md', 'objects.json', 'identity.json']), sha256: hash, bytes: z.number().int().nonnegative().max(2000000) })).length(3),
  integrityMeaning: z.literal('package-signature-does-not-certify-contained-claims'),
  onlineCurrentState: z.literal('not-checked'), timestampAuthority: z.literal('signer-declared-time'),
});
export const trustContainerSchema = z.strictObject({ format: z.literal('galaxy-readable-trust/v1'),
  files: z.strictObject({ 'summary.md': z.string().max(500000), 'objects.json': z.string().max(2000000), 'identity.json': z.string().max(2000000) }),
  manifestJson: z.string().max(20000), signature: z.string().max(40000) });
