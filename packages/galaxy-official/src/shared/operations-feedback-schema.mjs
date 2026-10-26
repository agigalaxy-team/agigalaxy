import {z} from 'zod';
import {feedbackAttachmentReferencesSchema} from './feedback-attachments-v1-schema.mjs';
import {ServiceError} from './service-error.mjs';

export const feedbackCategories=Object.freeze(['problem','suggestion']);
export const feedbackModules=Object.freeze(['account','community','chat','work','discovery','other']);
export const feedbackStates=Object.freeze(['pending','processing','closed']);
export const feedbackAuditActions=Object.freeze(['feedback-query','feedback-read','feedback-update']);
const text=max=>z.string().trim().min(1).max(max).refine(value=>!Array.from(value).some(char=>char.codePointAt(0)<32&&!['\n','\t','\r'].includes(char)));
const category=z.enum(feedbackCategories).nullable();
const module=z.enum(feedbackModules);
const state=z.enum(feedbackStates);
const sequence=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const feedbackSubmitSchema=z.strictObject({operationId:z.uuid(),title:text(120).optional(),body:text(6000),category:category.default(null),module:module.default('other'),attachments:feedbackAttachmentReferencesSchema.optional()});
export const feedbackQuerySchema=z.strictObject({query:z.string().trim().max(200).default(''),category:z.enum(['unclassified',...feedbackCategories]).optional(),
 module:module.optional(),state:state.optional(),days:z.union([z.literal(7),z.literal(28),z.literal('all')]).default(7),after:sequence.optional(),limit:z.number().int().min(1).max(100).default(30)});
export const feedbackHistorySchema=z.strictObject({historyAfter:sequence.optional()});
export const feedbackEventSchema=z.strictObject({operationId:z.uuid(),expectedRevision:z.number().int().min(1).max(2147483646),
 category:category.optional(),module:module.optional(),state:state.optional(),note:text(2000).optional()})
 .refine(value=>['category','module','state','note'].some(key=>Object.hasOwn(value,key)));
// Only immutable command metadata can leave the original-operation reader.
// Feedback prose and internal notes remain in their existing private records.
export const feedbackEventAuditSelectionSchema=z.strictObject({id:z.uuid(),resourceId:z.uuid(),operationId:z.uuid(),expectedRevision:z.number().int().min(1).max(2147483646),
 category:category.optional(),module:module.optional(),state:state.optional(),noteHash:z.string().regex(/^[a-f0-9]{64}$/).nullable()})
 .refine(value=>value.id===value.resourceId&&(['category','module','state'].some(key=>Object.hasOwn(value,key))||value.noteHash!==null));
export const feedbackEventAuditResultSchema=z.strictObject({feedbackId:z.uuid(),revision:z.number().int().min(2).max(2147483647),operationId:z.uuid(),recordedAt:z.iso.datetime({offset:true})});
export function parseFeedback(schema,input){const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_feedback_request',400);return result.data;}
