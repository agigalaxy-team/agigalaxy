import * as z from 'zod/v4';
const version = z.number().int().positive().max(1000);
const ref = z.strictObject({ id: z.uuid(), version });
const unique = (values) =>
  new Set(values.map((v) => v.id + ':' + v.version)).size === values.length;
const common = {
  schemaVersion: z.literal(2),
  operationId: z.uuid(),
  id: z.uuid(),
  expectedVersion: z.number().int().min(0).max(999),
};
export const packUseEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('record'),
    pack: z.strictObject({
      builderId: z.uuid(),
      manifestId: z.uuid(),
      manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    caseId: z.uuid(),
    attempt: ref,
    configuration: ref,
    result: ref.nullable().default(null),
    evidenceRefs: z.array(ref).max(20).refine(unique),
    verificationRefs: z.array(ref).max(20).refine(unique),
    follows: z
      .strictObject({ id: z.uuid(), kind: z.enum(['upgrade', 'retry']) })
      .nullable()
      .default(null),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('revoke'),
    reason: z.string().trim().min(1).max(1000),
  }),
]);
export const packUseReadSchema = z.strictObject({
  id: z.uuid(),
  version: version.optional(),
});
export const packUseQuerySchema = z.strictObject({
  builderId: z.uuid().optional(),
  subjectId: z
    .string()
    .regex(/^GUID[0-9A-Z]{28}$/)
    .optional(),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(30).default(10),
});
export const packUseCandidatesSchema = z.strictObject({
  caseId: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(10).default(5),
});
export const packUseReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const packManifestReadSchema = z.strictObject({
  builderId: z.uuid(),
  manifestId: z.uuid(),
  manifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
