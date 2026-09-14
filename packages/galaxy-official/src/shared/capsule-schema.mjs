import * as z from 'zod/v4';
import { capabilityIdSchema } from './qualification-schema.mjs';
const text=z.string().trim().min(1).max(1200), subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
const environment=z.strictObject({name:z.string().trim().min(1).max(160),version:z.string().trim().min(1).max(80)});
const refs=z.array(z.string().trim().min(1).max(160)).max(16);
const common={id:z.uuid(),capsuleId:z.uuid()};
export const capsuleVersionSchema=z.strictObject({...common,kind:z.literal('version'),expectedRevision:z.number().int().nonnegative(),version:z.number().int().min(1).max(100),
  title:z.string().trim().min(1).max(160),problemPattern:text,environment,solutionStrategy:z.string().trim().min(1).max(4000),
  tools:refs,skills:refs,mcpRefs:refs,verificationMethod:text,limitations:z.array(text).min(1).max(8),
  capabilityId:capabilityIdSchema,applicableScope:text,license:z.string().trim().min(1).max(80),contributors:z.array(subject).max(16),
  sourceResolution:z.strictObject({caseId:z.uuid(),resultId:z.uuid(),proofIds:z.array(z.uuid()).max(16)}),
  redactionConfirmed:z.literal(true)
}).refine(v=>new Set(v.contributors).size===v.contributors.length&&new Set(v.sourceResolution.proofIds).size===v.sourceResolution.proofIds.length);
const lifecycle={...common,expectedRevision:z.number().int().positive(),versionId:z.uuid(),summary:text};
export const capsuleEventSchema=z.discriminatedUnion('kind',[capsuleVersionSchema,
  z.strictObject({...lifecycle,kind:z.literal('deprecate'),replacementVersionId:z.uuid().optional()}),
  z.strictObject({...lifecycle,kind:z.literal('security-issue')}),
  z.strictObject({...lifecycle,kind:z.literal('resolve-security')})]);
const use={...common,versionId:z.uuid(),caseId:z.uuid(),attribution:subject,note:text};
const applied={...use,attemptId:z.uuid(),resultId:z.uuid(),environment,environmentDifference:text,
  outcome:z.enum(['succeeded','partial','failed','inconclusive','conflicting'])};
export const capsuleUseSchema=z.discriminatedUnion('kind',[
  z.strictObject({...use,kind:z.literal('reference')}),
  z.strictObject({...applied,kind:z.literal('apply')}),
  z.strictObject({...applied,kind:z.literal('reverify'),priorUseId:z.uuid(),proofIds:z.array(z.uuid()).min(1).max(16)})]);
export const capsuleQuerySchema=z.strictObject({query:z.string().trim().max(200).default(''),capabilityId:capabilityIdSchema.optional(),
  authorId:subject.optional(),after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)});
export const capsuleReadSchema=z.strictObject({capsuleId:z.uuid(),versionId:z.uuid().optional()});
export const capsuleUsesQuerySchema=z.strictObject({capsuleId:z.uuid().optional(),versionId:z.uuid().optional(),caseId:z.uuid().optional(),
  after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)}).refine(v=>!!v.capsuleId||!!v.caseId);
