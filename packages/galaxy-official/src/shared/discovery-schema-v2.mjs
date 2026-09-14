import * as z from 'zod/v4';
import { functionTagsSchema } from './discovery-schema.mjs';

export const discoveryPurposesV2Schema = z.array(z.enum(['conversation', 'reuse', 'collaboration', 'recruitment']))
  .min(1).max(4).refine(values => new Set(values).size === values.length);
export const queryContextV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ephemeral'), title: z.string().trim().min(1).max(120),
    functions: functionTagsSchema.refine(values => values.length > 0), technologies: functionTagsSchema.default([]) }),
  z.strictObject({ kind: z.literal('project'), projectId: z.uuid() }),
]);
const subjectId=z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const opportunityRefV2Schema = z.union([
  z.strictObject({subjectId,projectId:z.uuid(),statementId:z.uuid()}),
  z.strictObject({sourceKind:z.literal('project'),subjectId,projectId:z.uuid(),documentEventId:z.uuid(),policyEventId:z.uuid()}),
  z.strictObject({sourceKind:z.literal('recruitment'),subjectId,projectId:z.uuid(),recruitmentId:z.uuid(),eventId:z.uuid()}),
]);
export function sameOpportunityRef(left,right){return left.subjectId===right.subjectId&&left.projectId===right.projectId&&left.sourceKind===right.sourceKind&&
 (left.sourceKind==='recruitment'?left.recruitmentId===right.recruitmentId&&left.eventId===right.eventId
  :left.sourceKind==='project'?left.documentEventId===right.documentEventId&&left.policyEventId===right.policyEventId:left.statementId===right.statementId);}
const common = { context: queryContextV2Schema, purposes: discoveryPurposesV2Schema.default(['conversation']) };
export const discoveryQueryV2Schema = z.strictObject({ ...common,
  after: z.string().min(1).max(4096).nullable().default(null), limit: z.number().int().min(1).max(20).default(20),
});
export const discoveryDetailV2Schema = z.strictObject({ ...common, opportunityRef: opportunityRefV2Schema,
  experienceAfter: z.string().min(1).max(4096).nullable().default(null),
  experienceLimit: z.number().int().min(1).max(20).default(20),
});
