import * as z from 'zod/v4';
import {ServiceError} from './service-error.mjs';

const uuid=z.uuid();
const filename=z.string().trim().min(1).max(180).refine(value=>!['.','..'].includes(value)&&!Array.from(value).some(character=>character==='/'||character==='\\'||character.charCodeAt(0)<32||character.charCodeAt(0)===127));
export const feedbackAttachmentReferenceSchema=z.strictObject({id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const feedbackAttachmentReferencesSchema=z.array(feedbackAttachmentReferenceSchema).max(4).refine(values=>new Set(values.map(value=>value.id)).size===values.length);
export const feedbackAttachmentTargetSchema=z.strictObject({operationId:uuid,attachmentId:uuid});
export const feedbackAttachmentPrepareSchema=feedbackAttachmentTargetSchema.extend({name:filename,
 mediaType:z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
 size:z.number().int().min(1).max(67108864),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const feedbackAttachmentUploadSchema=z.strictObject({operationId:uuid});
// Bounded engineering defaults, not user-selected retention numbers. Only an
// explicit protected attachment configuration may override these candidates.
export const feedbackAttachmentPolicySchema=z.strictObject({draftRetentionDays:z.number().int().min(1).max(30),submittedRetentionDays:z.number().int().min(1).max(365)})
 .refine(value=>value.submittedRetentionDays>=value.draftRetentionDays);
export const defaultFeedbackAttachmentPolicy=Object.freeze(feedbackAttachmentPolicySchema.parse({draftRetentionDays:7,submittedRetentionDays:30}));
export function parseFeedbackAttachment(schema,input){const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_feedback_attachment_request',400);return result.data;}
