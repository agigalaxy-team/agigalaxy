import {z} from 'zod';

export const businessOperatorSchema=z.strictObject({
 kind:z.literal('business-operator'),operatorId:z.string().min(1).max(1024),
 role:z.enum(['administrator','reader']),endpoint:z.url(),httpRequestId:z.uuid().nullable().optional()
});
export const businessUsersQuerySchema=z.strictObject({
 query:z.string().trim().max(320).default(''),after:z.string().regex(/^G[A-Z0-9]{10}[0-9]$/).optional(),
 limit:z.number().int().min(1).max(100).default(20)
});
export const businessAuditQuerySchema=z.strictObject({
 accountId:z.uuid().optional(),resourceId:z.uuid().optional(),after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n).optional(),
 limit:z.number().int().min(1).max(100).default(30)
});
export const accountTypeChangeSchema=z.strictObject({
 expectedRevision:z.number().int().nonnegative(),subjectType:z.enum(['person','organization','agent']),
 reason:z.string().trim().min(8).max(2000),basis:z.string().trim().min(8).max(4000),preserveHistory:z.literal(true)
});
export const businessTypeChangeSchema=accountTypeChangeSchema.extend({operationId:z.uuid()});
export const businessRestrictionSchema=z.strictObject({
 operationId:z.uuid(),expectedRevision:z.number().int().nonnegative(),
 until:z.iso.datetime({offset:true}),reason:z.string().trim().min(3).max(2000)
});
export const businessReleaseRestrictionSchema=z.strictObject({
 operationId:z.uuid(),expectedRevision:z.number().int().nonnegative(),reason:z.string().trim().min(3).max(2000)
});
