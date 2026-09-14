import * as z from 'zod/v4';
import {
  searchV2QuerySchema,
  searchV2ReferenceSchema,
} from './search-v2-schema.mjs';
import { honorQueryV2Schema } from './honor-v2-schema.mjs';

export const informationSourceSchema = z.union([
  z.strictObject({ kind: z.literal('search'), request: searchV2QuerySchema }),
  z.strictObject({
    kind: z.literal('reference'),
    request: searchV2ReferenceSchema,
  }),
  z.strictObject({ kind: z.literal('honor'), request: honorQueryV2Schema }),
]);
export const informationSelectionSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  source: informationSourceSchema,
});
export const informationQuerySchema = z
  .strictObject({
    purpose: z.string().trim().min(1).max(300),
    queryId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sources: z.array(informationSelectionSchema).min(1).max(8),
  })
  .refine(
    (x) => new Set(x.sources.map((s) => s.key)).size === x.sources.length,
  );
const report = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('changes') }),
  z.strictObject({
    mode: z.literal('daily'),
    utcMinute: z.number().int().min(0).max(1439),
  }),
]);
export const informationWatchPlanSchema = z
  .strictObject({
    purpose: z.string().trim().min(1).max(300),
    sources: z.array(informationSelectionSchema).min(1).max(4),
    expiresAt: z.number().int().positive(),
    report: report.default({ mode: 'changes' }),
  })
  .refine(
    (x) => new Set(x.sources.map((s) => s.key)).size === x.sources.length,
  );
const base = {
  operationId: z.uuid(),
  watchId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
};
export const informationWatchCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...base,
    action: z.enum(['start', 'revise']),
    plan: informationWatchPlanSchema,
  }),
  z.strictObject({ ...base, action: z.enum(['pause', 'resume', 'end']) }),
]);
export const informationWatchReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const informationWatchReadSchema = z.strictObject({
  activeOnly: z.boolean().default(false),
  watchId: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export const informationWatchCheckSchema = z.strictObject({
  watchId: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
