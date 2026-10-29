import * as z from 'zod/v4';
import {qualificationSourceGrantRef} from './qualification-calculation-schema.mjs';
const id=z.uuid(),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),common={eventId:id,requestId:id,expectedVersion:z.number().int().nonnegative()};
const externalReviewRefs=z.array(z.strictObject({id,version:z.number().int().positive()})).max(32).default([]);
export const qualificationPlanSchema=z.strictObject({taskId:id,participationIds:z.array(id).max(32).default([]),externalReviewRefs,expiresAt:z.iso.datetime()})
  .refine(p=>p.participationIds.length+p.externalReviewRefs.length>0);
export const qualificationRequestEventSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('request'),taskId:id,sourceAuthorId:subject,participationIds:z.array(id).max(32).default([]),externalReviewRefs,
  sourceRefs:z.array(qualificationSourceGrantRef).min(1).max(128),expiresAt:z.iso.datetime(),purpose:z.literal('request-scoped-qualification-permission-only; no-permission-granted')})
  .refine(p=>p.participationIds.length+p.externalReviewRefs.length>0),
 z.strictObject({...common,kind:z.enum(['decline','cancel']),reason:z.string().trim().min(1).max(500)}),
 z.strictObject({...common,kind:z.literal('record-permission'),grantId:id}),
]);
export const qualificationRequestReadSchema=z.strictObject({requestId:id});
export const qualificationRequestQuerySchema=z.strictObject({view:z.enum(['sent','received']).default('received'),taskId:id.optional(),after:id.optional(),limit:z.number().int().min(1).max(30).default(12)});
export const qualificationRequestReceiptSchema=z.strictObject({eventId:id,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
