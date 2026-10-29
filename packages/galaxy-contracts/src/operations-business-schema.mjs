import {z} from 'zod';

const id=z.uuid(),text=z.string().trim().min(3).max(1600),version=z.number().int().min(0).max(2147483647);
export const operationsPageSchema=z.strictObject({after:id.optional(),limit:z.number().int().min(1).max(100).default(25)});
export const operationsSectionsQuerySchema=operationsPageSchema.extend({state:z.enum(['active','archived']).optional(),category:z.enum(['technology','arts','learning','life','galaxy','unclassified']).optional()});
export const operationsReportsQuerySchema=operationsPageSchema.extend({state:z.enum(['pending','appealed','resolved','withdrawn']).optional()});
export const operationsSectionClassificationSchema=z.strictObject({operationId:id,expectedVersion:version,category:z.enum(['technology','arts','learning','life','galaxy','unclassified']),reason:text});
export const operationsVisibilitySchema=z.discriminatedUnion('kind',[
 z.strictObject({operationId:id,kind:z.literal('hide'),expectedVersion:version,expectedVisibilityVersion:version,until:z.number().int().positive(),reason:text}),
 z.strictObject({operationId:id,kind:z.literal('restore'),expectedVersion:version,expectedVisibilityVersion:version,reason:text})
]);
export const operationsForumDecisionSchema=z.strictObject({operationId:id,expectedVersion:version,resolution:z.enum(['accepted','dismissed','needs-review']),summary:text,
 restrictionAction:z.enum(['keep','release','hide']).optional(),hideUntil:z.number().int().positive().optional()})
 .refine(value=>(value.restrictionAction??(value.hideUntil!==undefined?'hide':'keep'))==='hide'?value.hideUntil!==undefined:value.hideUntil===undefined);
export const operationsResourcesQuerySchema=operationsPageSchema.extend({state:z.enum(['active','archived']).optional()});
const fileFilters={kind:z.enum(['chat','forum']).optional(),state:z.enum(['prepared','uploading','scan-pending','scanning','available','blocked','erased','expired','revoked']).optional(),processing:z.enum(['scan','cleanup']).optional(),issue:z.enum(['any','scan','cleanup']).optional()};
export const operationsFilesSummaryQuerySchema=z.strictObject(fileFilters);
export const operationsFilesQuerySchema=operationsPageSchema.extend({...fileFilters,after:z.string().regex(/^(chat|forum):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional()});
export const operationsFileRetrySchema=z.strictObject({operationId:id,kind:z.enum(['scan','cleanup']),expectedVersion:z.string().min(1).max(512),reason:text});

