import * as z from 'zod/v4';
import { capsuleVersionSchema, capsuleReadSchema, capsuleQuerySchema, capsuleUsesQuerySchema } from './capsule-schema.mjs';
import { factReferenceSchema } from './cases-schema.mjs';

const text = z.string().trim().min(1).max(1600), subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const factSource = z.strictObject({ kind: z.enum(['case-root', 'attempt', 'intervention', 'result', 'evidence', 'verification']),
  ...factReferenceSchema.shape, caseId: z.uuid() });
export const capsuleSourceV2Schema = z.union([factSource,
  z.strictObject({ kind: z.literal('configuration'), ...factReferenceSchema.shape }),
  z.strictObject({ kind: z.literal('selected-message'), ...factReferenceSchema.shape }),
  z.strictObject({ kind: z.literal('outcome-material'), ...factReferenceSchema.shape, caseId: z.uuid() })]);
const sources = z.array(capsuleSourceV2Schema).min(1).max(64);
export const capsulePermissionV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('grant'), id: z.uuid(),
    sources, grantees: z.array(subject).min(1).max(32), license: z.string().trim().min(1).max(80),
    scope: text, basis: z.enum(['authored-content', 'documented-covering-license']),
    licenseReference: z.string().trim().min(1).max(1200).optional(),
    attribution: text, allowPublic: z.boolean(), expiresAt: z.iso.datetime().optional(),
  }).refine(v => v.basis !== 'documented-covering-license' || !!v.licenseReference),
  z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('revoke'), id: z.uuid(), permissionId: z.uuid(), reason: text }),
]);

export const capsuleVersionV2Schema = capsuleVersionSchema.safeExtend({ schemaVersion: z.literal(2),
  publicationClass: z.literal('formal-source-success'), synthetic: z.boolean(),
  sourceResolution: z.strictObject({ caseId: z.uuid(), resultId: z.uuid(), resultVersion: z.number().int().positive(),
    proofIds: z.array(z.uuid()).max(16).default([]), verificationRefs: z.array(factReferenceSchema).max(16).default([]) }),
  sourceRefs: z.array(capsuleSourceV2Schema).max(64), permissionRefs: z.array(z.uuid()).max(64),
  attributionRefs: z.array(z.strictObject({ subjectId: subject, source: capsuleSourceV2Schema })).max(32),
  externalReferences: z.array(z.strictObject({ url: z.url(), description: text, license: z.string().max(160).nullable(),
    inclusion: z.literal('reference-only; no-imported-body') })).max(16).default([]),
});
const lifecycle = { schemaVersion: z.literal(2), id: z.uuid(), capsuleId: z.uuid(), expectedRevision: z.number().int().positive(), versionId: z.uuid(), summary: text };
export const capsuleEventV2Schema = z.discriminatedUnion('kind', [capsuleVersionV2Schema,
  z.strictObject({ ...lifecycle, kind: z.literal('deprecate'), replacementVersionId: z.uuid().optional() }),
  z.strictObject({ ...lifecycle, kind: z.literal('security-issue') }), z.strictObject({ ...lifecycle, kind: z.literal('resolve-security') })]);

const common = { schemaVersion: z.literal(2), id: z.uuid(), capsuleId: z.uuid(), versionId: z.uuid(), caseId: z.uuid(),
  attribution: subject, note: text, taskId: z.uuid().optional(), participationId: z.uuid().optional() };
export const capsuleOriginV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attempt'), ...factReferenceSchema.shape }),
  z.strictObject({ kind: z.literal('intervention'), ...factReferenceSchema.shape }),
]);
const applied = { ...common, attemptRef: factReferenceSchema.optional(), originRef: capsuleOriginV2Schema.optional(), resultRef: factReferenceSchema,
  configurationRef: factReferenceSchema.optional(),
  environment: z.strictObject({ name: z.string().min(1).max(160), version: z.string().min(1).max(80) }),
  environmentDifference: text, adoptedParts: z.array(text).min(1).max(16),
  outcome: z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']) };
export const capsuleUseV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('reference') }), z.strictObject({ ...applied, kind: z.literal('apply') }),
  z.strictObject({ ...applied, kind: z.literal('reverify'), priorUseId: z.uuid(), verificationRefs: z.array(factReferenceSchema).min(1).max(16) })])
  .refine(p => p.kind === 'reference' || (p.originRef ? p.originRef.kind === 'intervention' ? !p.attemptRef
    : !p.attemptRef || p.attemptRef.id === p.originRef.id && p.attemptRef.version === p.originRef.version : !!p.attemptRef),
  'One exact Attempt or Intervention origin is required; legacy Attempt references must match.')
  .refine(p => p.kind === 'reference' || !p.configurationRef || p.originRef?.kind === 'intervention',
  'Selected configuration is only used for an Intervention application.');
export const capsuleUseOriginRef = payload => payload.originRef ?? { kind: 'attempt', ...payload.attemptRef };
export const capsulePreviewV2Schema = z.strictObject({ payload: capsuleVersionV2Schema,
  visibility: z.enum(['Private', 'Public']).default('Public') });
export const capsuleReceiptV2Schema=z.strictObject({type:z.enum(['publication','use','permission']),operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
export const capsuleVersionsV2Schema=z.strictObject({capsuleId:z.uuid(),after:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
export const capsulePermissionsQueryV2Schema=z.strictObject({view:z.enum(['owned','granted']).default('owned'),after:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
export { capsuleReadSchema, capsuleQuerySchema, capsuleUsesQuerySchema };
