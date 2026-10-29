import * as z from 'zod/v4';
import { queryContextV2Schema, opportunityRefV2Schema } from './discovery-schema-v2.mjs';
const subjectId=z.string().regex(/^GUID[0-9A-Z]{28}$/);
const common={operationId:z.uuid(),contactId:z.uuid(),expectedRevision:z.number().int().nonnegative()};
export const contactEventV2Schema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('send'),recipientId:subjectId,purpose:z.enum(['conversation','reuse','collaboration','recruitment']),
    context:queryContextV2Schema,opportunityRef:opportunityRefV2Schema,note:z.string().trim().min(1).max(2000),roomTitle:z.string().trim().min(1).max(120).default('银河交流')}),
  z.strictObject({...common,kind:z.enum(['accept','decline','withdraw']),note:z.string().trim().max(2000).default('')}),
]);
export const contactEnvelopeV2Schema=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(2).max(8000)});
