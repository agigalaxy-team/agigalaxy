import * as z from 'zod/v4';
import { capabilityIdSchema } from './qualification-schema.mjs';

export const historyFieldPolicySchema=z.strictObject({id:z.literal('history-fields'),version:z.literal(1),view:z.enum(['owner','authorized','public'])});
export const historyRefreshSchema=z.strictObject({mode:z.literal('on-demand'),state:z.literal('rebuilt'),backgroundQueue:z.literal(false),checkedAt:z.number().int().nonnegative()});
export const historyProgressSchema=z.strictObject({version:z.literal(1),authority:z.literal('case-owner-reported'),latestResultId:z.uuid().nullable(),
  timeline:z.array(z.strictObject({resultId:z.uuid(),attemptId:z.uuid(),outcome:z.enum(['succeeded','partial','failed','inconclusive','conflicting']),sourceEventVersion:z.number().int().positive(),corrected:z.boolean()})).max(1000),
  subsequentReports:z.array(z.strictObject({previousSuccessId:z.uuid(),resultId:z.uuid(),attemptRelation:z.enum(['same-attempt','different-attempt']),regressionVerified:z.literal(false)})).max(1000),
  capabilityVerified:z.literal(false),attemptCountIsCapability:z.literal(false)});

export const historyQuerySchema = z.strictObject({
  subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),
  query: z.string().trim().max(200).default(''),
  outcome: z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']).optional(),
  capabilityId: capabilityIdSchema.optional(),
  verificationStrength: z.enum(['reported-only','ci-execution-fact']).optional(),
  sourceKind: z.enum(['local', 'bridge', 'hub']).optional(),
  environment: z.string().trim().min(1).max(160).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdBefore: z.iso.datetime().optional(),
  after: z.uuid().optional(), limit: z.number().int().min(1).max(50).default(20)
}).refine(value => new Set(value.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean)).size <= 8)
  .refine(value => !value.createdFrom || !value.createdBefore || Date.parse(value.createdFrom) < Date.parse(value.createdBefore));
