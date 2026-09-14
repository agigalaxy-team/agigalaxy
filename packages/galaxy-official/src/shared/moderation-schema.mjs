import * as z from 'zod/v4';
const reportFields={id:z.uuid(),category:z.enum(['abuse','privacy','misrepresentation','scope','other','malicious-artifact','data-extraction','work-fraud','false-verification']),summary:z.string().trim().min(1).max(1200)};
export const moderationReportSchema=z.union([
  z.strictObject({...reportFields,assistanceId:z.uuid()}),
  z.strictObject({...reportFields,caseId:z.uuid(),caseVersion:z.number().int().positive().max(1000),targetEventId:z.uuid(),evidenceId:z.uuid().optional()})
]);
export const moderationReferenceSchema=z.union([
  z.strictObject({kind:z.enum(['case','evidence','proof','event']),id:z.uuid()}),
  z.strictObject({kind:z.literal('artifact'),sha256:z.string().regex(/^[a-f0-9]{64}$/)})
]);
const common={id:z.uuid(),reportId:z.uuid(),expectedVersion:z.number().int().positive(),summary:z.string().trim().min(1).max(1200)};
export const moderationVerifierTargetSchema=z.union([
  z.strictObject({assistanceId:z.uuid()}),
  z.strictObject({caseId:z.uuid(),caseVersion:z.number().int().positive().max(1000),targetEventId:z.uuid(),evidenceId:z.uuid().optional()})
]);
export const moderationEventSchema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('pause')}),z.strictObject({...common,kind:z.literal('resume')}),
  z.strictObject({...common,kind:z.literal('resolve'),verdict:z.enum(['upheld','dismissed'])}),z.strictObject({...common,kind:z.literal('appeal')}),
  z.strictObject({...common,kind:z.literal('revalidate'),evidenceId:z.uuid()}),
  z.strictObject({...common,kind:z.literal('supplement'),references:z.array(moderationReferenceSchema).max(8).default([])}),
  z.strictObject({...common,kind:z.literal('correct'),correctsEventId:z.uuid(),reason:z.string().trim().min(1).max(1200)}),
  z.strictObject({...common,kind:z.literal('invite-verifier'),verifierId:z.string().regex(/^GUID[0-9A-Z]{28}$/),target:moderationVerifierTargetSchema,
    scope:z.string().trim().min(1).max(1200),expiresAt:z.number().int().positive()}),
  ...['accept-verifier','decline-verifier','withdraw-verifier'].map(kind=>z.strictObject({...common,kind:z.literal(kind),invitationId:z.uuid()})),
  z.strictObject({...common,kind:z.literal('verification-response'),invitationId:z.uuid(),conclusion:z.enum(['supported','unsupported','inconclusive']),
    references:z.array(moderationReferenceSchema).max(8).default([])})
]);
export const moderatorIdsSchema=z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(8).refine(ids=>new Set(ids).size===ids.length);
