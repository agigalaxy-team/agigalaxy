import {z} from 'zod/v4';
export const contributionSourceRefSchema=z.strictObject({kind:z.enum(['case-event','task-event']),id:z.uuid(),eventVersion:z.literal(1),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
export const contributionProjectionFields=['eventType','actorId','role','interventionTypes','scopeVersion','reportedOutcome','feedback','scope','title','summary','time','caseId','taskId','participationId'];
export const contributionOwnedSourcesSchema=z.strictObject({kind:z.enum(['case-event','task-event']),parentId:z.uuid(),after:z.uuid().optional(),limit:z.number().int().min(1).max(100).default(30)});
export const contributionStatusSchema=z.strictObject({publicationId:z.uuid()});
const fields=z.array(z.enum(contributionProjectionFields)).min(2).max(contributionProjectionFields.length).refine(v=>new Set(v).size===v.length&&v.includes('eventType')&&v.includes('actorId'));
const projectedSource=contributionSourceRefSchema.extend({fields});
const purposes=z.array(z.enum(['honor','requester-history'])).min(1).max(2).refine(v=>new Set(v).size===v.length);
export const contributionPreviewSchema=z.strictObject({sourceRefs:z.array(projectedSource).min(1).max(128),purposes});
export const contributionProjectionReadSchema=z.union([
  z.strictObject({source:contributionSourceRefSchema,purpose:z.enum(['honor','requester-history'])}),
  z.strictObject({publicationId:z.uuid(),sourceKey:z.string().regex(/^[a-f0-9]{64}$/),purpose:z.enum(['honor','requester-history'])})]);
export const contributionPublicationSchema=z.discriminatedUnion('kind',[
  z.strictObject({id:z.uuid(),kind:z.literal('publish'),sourceRefs:z.array(projectedSource).min(1).max(128),purposes,
    purpose:z.literal('public-contribution-projections-only'),expiresAt:z.iso.datetime(),
    redactionConfirmed:z.literal(true),publicationScope:z.literal('selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged')}),
  z.strictObject({id:z.uuid(),kind:z.literal('revoke'),publicationId:z.uuid(),reason:z.string().trim().min(1).max(1600)})
]);
