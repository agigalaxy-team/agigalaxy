import {z} from 'zod';
const limit=z.number().int().min(1).max(50).default(25);
export const operationsFileCleanupCandidatesSchema=z.strictObject({kind:z.enum(['chat','forum']).optional(),after:z.string().regex(/^(chat|forum):[0-9a-f-]{36}$/).refine(value=>z.uuid().safeParse(value.split(':')[1]).success).optional(),limit});
export const operationsFileCleanupPlansSchema=z.strictObject({after:z.uuid().optional(),limit});
export const operationsFileCleanupCreateSchema=z.strictObject({operationId:z.uuid(),items:z.array(z.strictObject({kind:z.enum(['chat','forum']),id:z.uuid(),expectedVersion:z.string().min(1).max(4096)})).min(1).max(50)
 .refine(items=>new Set(items.map(item=>item.kind+':'+item.id)).size===items.length),reason:z.string().trim().max(1600).default('')});
export const operationsFileCleanupDecisionSchema=z.strictObject({operationId:z.uuid(),expectedRevision:z.number().int().min(1)});
