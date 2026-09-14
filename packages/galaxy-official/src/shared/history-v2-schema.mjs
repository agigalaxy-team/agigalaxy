import * as z from 'zod/v4';
import { capabilityIdSchema } from './qualification-schema.mjs';

export const historyV2QuerySchema = z.strictObject({
  subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/),
  query: z.string().trim().max(200).default(''),
  capabilityId: capabilityIdSchema.optional(),
  timeWindow: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all-visible') }),
    z.strictObject({ kind: z.enum(['90-days', '365-days']) }),
    z.strictObject({ kind: z.literal('custom'), from: z.iso.datetime(), before: z.iso.datetime() }),
  ]).default({ kind: 'all-visible' }),
  context: z.strictObject({ taskId: z.uuid().optional(), environment: z.string().trim().min(1).max(160).optional() }).optional(),
  after: z.string().min(1).max(4096).nullable().default(null),
  limit: z.number().int().min(1).max(50).default(20),
}).refine(input => input.timeWindow.kind !== 'custom' || Date.parse(input.timeWindow.from) < Date.parse(input.timeWindow.before))
  .refine(input => input.query.split(/\s+/).filter(Boolean).length <= 8);
