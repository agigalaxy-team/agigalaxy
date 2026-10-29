import * as z from 'zod/v4';
import { historyV2QuerySchema } from './history-v2-schema.mjs';
import { capsuleQuerySchema } from './capsule-schema.mjs';
import { proofSearchSchema, searchQuerySchema, searchScope } from './search-schema.mjs';
import { taskQueryV2Schema } from './task-schema-v2.mjs';
import { discoveryQueryV2Schema } from './discovery-schema-v2.mjs';

const limit = z.number().int().min(1).max(20).default(8);
export const searchHistoryV2QuerySchema = historyV2QuerySchema.safeExtend({ subjectId: historyV2QuerySchema.shape.subjectId.optional(), limit });
const source = (type, query) => z.strictObject({ type: z.literal(type), query });
export const searchV2QuerySchema = z.union([
  source('history', searchHistoryV2QuerySchema), source('case', searchHistoryV2QuerySchema),
  source('capsule', capsuleQuerySchema), source('proof', proofSearchSchema),
  source('task', taskQueryV2Schema.extend({ limit })), source('opportunity', discoveryQueryV2Schema.extend({ limit })),
  searchQuerySchema.options[4], searchQuerySchema.options[5],
]);
export const searchV2Scope = type => type === 'task' ? 'assistance' : type === 'opportunity' ? 'history' : searchScope(type);
export const searchV2ReferenceSchema = z.strictObject({
  search: searchV2QuerySchema,
  ref: z.strictObject({ id: z.string().min(1).max(160), version: z.string().regex(/^[0-9a-f]{64}$/) }),
});
