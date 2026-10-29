import * as z from 'zod/v4';
import {qualificationEvidenceV2Schema} from './qualification-v2-schema.mjs';
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const qualificationSourceGrantRef=z.strictObject({kind:z.enum(['case-event','task-event','experience-event']),id:z.uuid(),
  eventVersion:z.literal(1),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
const sourceRefs=z.array(qualificationSourceGrantRef).min(1).max(128);
const common={id:z.uuid(),taskId:z.uuid(),candidateId:subject,recipientId:subject,purpose:z.literal('this-task-eligibility-computation-only'),
  expiresAt:z.iso.datetime(),sourceRefs,disclosure:z.literal('public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity')};
export const qualificationCalculationSchema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('source-permission')}),
  z.strictObject({...common,kind:z.literal('compute'),permissionIds:z.array(z.uuid()).max(64),evidence:qualificationEvidenceV2Schema.omit({calculationGrantId:true})}),
  z.strictObject({id:z.uuid(),kind:z.literal('revoke'),grantId:z.uuid(),reason:z.string().trim().min(1).max(1600)}),
]);
