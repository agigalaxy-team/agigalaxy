import * as z from 'zod/v4';
import { functionTagsSchema } from './discovery-schema.mjs';
import { queryContextV2Schema } from './discovery-schema-v2.mjs';
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),positive=z.number().int().positive();
export const recruitmentDocumentV2Schema=z.strictObject({title:z.string().trim().min(1).max(120),
 role:z.string().trim().min(1).max(500),summary:z.string().trim().min(1).max(3000),
 functions:functionTagsSchema.refine(v=>v.length>0),technologies:functionTagsSchema.default([]),
 conditions:z.string().trim().max(2000).default(''),contactSubjectId:subject});
const common={operationId:z.uuid(),recruitmentId:z.uuid(),projectId:z.uuid(),expectedRevision:z.number().int().nonnegative()};
export const recruitmentEventV2Schema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.enum(['create','revise','renew']),document:recruitmentDocumentV2Schema,expiresAt:positive}),
 z.strictObject({...common,kind:z.enum(['pause','close']),note:z.string().trim().max(1000).default('')}),
 z.strictObject({...common,kind:z.literal('link-task'),taskId:z.uuid(),expectedTaskVersion:positive}),
]);
export const recruitmentEnvelopeV2Schema=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(2).max(10000)});
export const recruitmentQueryV2Schema=z.strictObject({view:z.enum(['discover','managed']).default('discover'),context:queryContextV2Schema.optional(),
 after:z.string().min(1).max(4096).nullable().default(null),limit:z.number().int().min(1).max(20).default(20)}).refine(x=>x.view!=='discover'||!!x.context);

export const recruitmentOperationReceiptQuerySchema=z.strictObject({recruitmentId:z.uuid(),operationId:z.uuid(),
 payloadHash:z.string().regex(/^[0-9a-f]{64}$/)});
const receiptCommon={schemaVersion:z.literal(2),query:recruitmentOperationReceiptQuerySchema,
 authority:z.literal('accepted-operation-only'),audience:z.literal('owner-only'),currentAccessGranted:z.literal(false),
 contentReturned:z.literal(false),sourceAccessChecked:z.literal(false)};
export const recruitmentOperationReceiptResultSchema=z.discriminatedUnion('state',[
 z.strictObject({...receiptCommon,state:z.literal('acknowledged'),receipt:z.strictObject({
  ...recruitmentOperationReceiptQuerySchema.shape,revision:positive,acceptedAt:z.iso.datetime()})}),
 z.strictObject({...receiptCommon,state:z.literal('absent'),absenceMeaning:z.literal('no-retained-owner-operation')}),
 z.strictObject({...receiptCommon,state:z.literal('conflict'),reason:z.literal('original-operation-mismatch')})
]).superRefine((value,ctx)=>{if(value.state==='acknowledged'&&['recruitmentId','operationId','payloadHash'].some(key=>value.query[key]!==value.receipt[key]))
 ctx.addIssue({code:'custom',message:'Original Recruitment receipt mismatch'});});
