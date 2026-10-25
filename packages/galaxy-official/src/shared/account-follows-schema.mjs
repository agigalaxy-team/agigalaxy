import * as z from 'zod/v4';

const revision=z.number().int().nonnegative(),epoch=z.number().int().nonnegative();
export const accountFollowCommandSchema=z.strictObject({operationId:z.uuid(),targetAccountId:z.uuid(),following:z.boolean(),expectedRevision:revision});
export const accountFollowStatusRequestSchema=z.strictObject({targetAccountId:z.uuid()});
export const accountFollowReceiptRequestSchema=z.strictObject({operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
export const accountFollowQuerySchema=z.strictObject({after:z.string().regex(/^af1\.[A-Za-z0-9_-]+$/).max(512).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const accountFollowRelationshipSchema=z.strictObject({id:z.uuid().nullable(),targetAccountId:z.uuid(),following:z.boolean(),revision,
 followedAt:z.string().datetime({offset:true}).nullable(),updatedAt:z.string().datetime({offset:true}).nullable()});
const publicProfile=z.strictObject({accountId:z.uuid(),uid:z.string().regex(/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{6,16}$/).nullable(),
 displayName:z.string().max(120).nullable(),subjectType:z.enum(['person','organization','agent']).nullable()});
const source=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('available'),profile:publicProfile}),
 z.strictObject({state:z.literal('unavailable'),profile:z.null()}),
]);
export const accountFollowStatusSchema=z.strictObject({accountId:z.uuid(),relationship:accountFollowRelationshipSchema,canFollow:z.boolean(),checkedAt:epoch});
export const accountFollowPageSchema=z.strictObject({accountId:z.uuid(),items:z.array(z.strictObject({relationship:accountFollowRelationshipSchema,source})).max(50),
 nextAfter:z.string().regex(/^af1\.[A-Za-z0-9_-]+$/).max(512).nullable(),checkedAt:epoch,readExpiresAt:epoch,visibility:z.literal('Private')});
export const accountFollowReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('acknowledged'),accountId:z.uuid(),operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),relationship:accountFollowRelationshipSchema}),
 z.strictObject({state:z.literal('absent'),accountId:z.uuid(),operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}),
]);
export const accountFollowMethods=Object.freeze(['status','query','command','receipt']);
export const accountFollowMethod=path=>typeof path==='string'?/^\/v1\/account\/follows\/(status|query|command|receipt)$/.exec(path)?.[1]??null:null;
