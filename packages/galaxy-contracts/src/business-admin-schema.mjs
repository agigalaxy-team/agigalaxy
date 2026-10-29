import {z} from 'zod';

export const businessOperatorSchema=z.strictObject({
 kind:z.literal('business-operator'),operatorId:z.string().min(1).max(1024),
 role:z.enum(['administrator','reader']),endpoint:z.url(),httpRequestId:z.uuid().nullable().optional(),
 businessAuthorization:z.strictObject({version:z.string().min(1).max(128),permissions:z.array(z.string().min(1).max(100)).max(256)}).optional()
});
// Only the server authority may mint this identity. Schema validation is a
// shape check; BusinessAdmin also requires its process-local attestation.
export const operationsExecutorSchema=z.strictObject({
 kind:z.literal('operations-executor'),operatorId:z.string().regex(/^executor:[0-9a-f-]{36}$/),role:z.null(),endpoint:z.url(),
 executionId:z.uuid(),grantId:z.uuid(),executorKind:z.enum(['program','ai']),mode:z.enum(['assisted','automatic']),
 onBehalfOf:z.string().min(1).max(1024).nullable(),resourceIds:z.array(z.uuid()).max(100),
 businessAuthorization:z.strictObject({version:z.string().min(1).max(128),permissions:z.array(z.string().min(1).max(100)).max(256)})
});
export const businessUsersQuerySchema=z.strictObject({
 query:z.string().trim().max(320).default(''),after:z.string().regex(/^G[A-Z0-9]{10}[0-9]$/).optional(),
 subjectType:z.enum(['person','organization','agent','unknown']).optional(),restriction:z.enum(['normal','restricted']).optional(),
 limit:z.number().int().min(1).max(100).default(20)
});
export const businessSummaryQuerySchema=z.strictObject({days:z.union([z.literal(7),z.literal(28)]).default(7)});
export const businessAuditQuerySchema=z.strictObject({
 accountId:z.uuid().optional(),resourceId:z.uuid().optional(),after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n).optional(),
 action:z.union([z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),z.enum(['recommendations.configure','search-quality.configure','search-quality.publish','search-quality.restore','models.configure','models.apply','strategies.configure','strategies.publish','strategies.control','strategies.run','strategies.ordinary.configure','strategies.ordinary.publish'])]).optional(),kind:z.enum(['all','business','reads']).default('all'),
 day:z.iso.date().refine(value=>!value.startsWith('0000-')).optional(),query:z.string().trim().max(160).default(''),
 limit:z.number().int().min(1).max(100).optional(),
 page:z.number().int().min(1).max(1000000).optional(),pageSize:z.union([z.literal(20),z.literal(30),z.literal(50),z.literal(100)]).optional(),
 snapshot:z.uuid().optional(),sort:z.enum(['newest','oldest']).optional()
}).superRefine((value,context)=>{
 if((value.page!==undefined||value.pageSize!==undefined||value.snapshot!==undefined||value.sort!==undefined)&&(value.after!==undefined||value.limit!==undefined))
  context.addIssue({code:'custom',message:'Page snapshots and legacy cursors cannot be combined.'});
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
