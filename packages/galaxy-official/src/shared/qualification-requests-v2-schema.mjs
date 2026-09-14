import * as z from 'zod/v4';
import {qualificationSourceGrantRef} from './qualification-calculation-schema.mjs';
const id=z.uuid(),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),common={eventId:id,requestId:id,expectedVersion:z.number().int().nonnegative()};
export const qualificationPlanSchema=z.strictObject({taskId:id,participationIds:z.array(id).min(1).max(32),expiresAt:z.iso.datetime()});
export const qualificationRequestEventSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('request'),taskId:id,sourceAuthorId:subject,participationIds:z.array(id).min(1).max(32),
  sourceRefs:z.array(qualificationSourceGrantRef).min(1).max(128),expiresAt:z.iso.datetime(),purpose:z.literal('request-scoped-qualification-permission-only; no-permission-granted')}),
 z.strictObject({...common,kind:z.enum(['decline','cancel']),reason:z.string().trim().min(1).max(500)}),
 z.strictObject({...common,kind:z.literal('record-permission'),grantId:id}),
]);
export const qualificationRequestReadSchema=z.strictObject({requestId:id});
export const qualificationRequestQuerySchema=z.strictObject({view:z.enum(['sent','received']).default('received'),taskId:id.optional(),after:id.optional(),limit:z.number().int().min(1).max(30).default(12)});
export const qualificationRequestReceiptSchema=z.strictObject({eventId:id,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
