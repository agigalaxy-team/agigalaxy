import { z } from 'zod';
const guid = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const common = { version: z.literal(1), id: z.uuid(), endpoint: z.url(), subjectId: guid, bindingId: z.uuid(),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() };
export const deletionIntentSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('request'), scope: z.literal('all-owned-service-data'),
    reason: z.enum(['account-exit', 'privacy', 'other']), takeout: z.enum(['already-exported', 'not-needed']),
    exportManifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ ...common, action: z.literal('cancel'), requestId: z.uuid(), expectedRevision: z.number().int().positive() }).strict(),
]).refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 300)
  .refine(value => value.action !== 'request' || !value.exportManifestSha256 || value.takeout === 'already-exported');
export const deletionReadSchema = z.object({ id: z.uuid(), afterRevision: z.number().int().nonnegative().default(0) }).strict();
export const deletionQuerySchema = z.object({ after: z.uuid().optional(), limit: z.number().int().min(1).max(20).default(10) }).strict();
export const deletionStates = ['requested', 'review-needed', 'approved', 'rejected', 'cancelled', 'partial', 'primary-erased'];
export const deletionStatusIntentSchema = z.object({version:z.literal(1),id:z.uuid(),action:z.literal('status'),requestId:z.uuid(),
  endpoint:z.url(),subjectId:guid,issuedAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive()}).strict()
  .refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=300);
