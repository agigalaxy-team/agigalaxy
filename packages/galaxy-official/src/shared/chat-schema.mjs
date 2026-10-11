import * as z from 'zod/v4';
import {attachmentReferenceSchema} from './chat-attachments-schema.mjs';
const id=z.uuid();
export const chatCreateSchema=z.object({roomId:id,operationId:id,title:z.string().trim().min(1).max(120),
 kind:z.enum(['ordinary','ai-subzone']).default('ordinary'),parentRoomId:id.optional(),
 taskRefs:z.array(id).max(20).default([]),retentionDays:z.union([z.literal(7),z.literal(30),z.literal(90)]).default(90)}).strict();
export const chatJoinRuleSchema=z.strictObject({mode:z.enum(['approval-required','member-invite','manager-invite','open']),expiresAt:z.number().int().positive().optional()});
export const chatDecisionSchema=z.object({decisionId:id,expectedRevision:z.number().int().positive(),
 action:z.enum(['invite','remove','retention','become-owner','transfer-owner','persistent','dissolve','join-rule','appoint-admin','revoke-admin','successor-owner']),
 targetSubjectId:z.string().regex(/^GUID[A-Z0-9]{28}$/).optional(),retentionDays:z.union([z.literal(7),z.literal(30),z.literal(90)]).optional(),persistent:z.boolean().optional(),joinRule:chatJoinRuleSchema.optional()}).strict();
export const chatJoinSchema=z.strictObject({operationId:id,ruleVersion:z.number().int().positive(),ruleHash:z.string().regex(/^[a-f0-9]{64}$/)});
// Optional without a default preserves canonical payloads of all old messages.
export const chatSendSchema=z.object({clientMessageId:id,text:z.string().min(1).max(16000),replyTo:id.nullable().default(null),agentGrantId:id.optional(),attachments:z.array(attachmentReferenceSchema).min(1).max(16).optional()}).strict();
const requestHash=z.string().regex(/^[0-9a-f]{64}$/);
// The old ID-only query retains current room permission. The exact hash path
// confirms only this owner's original operation, including normalized defaults.
export const chatMessageStatusSchema=z.strictObject({clientMessageId:id,requestHash:requestHash.optional()});
export const chatMessageReceiptSchema=z.strictObject({roomId:id,clientMessageId:id,requestHash});
export const chatMessageReceiptResultSchema=chatMessageReceiptSchema.extend({state:z.enum(['absent','conflict','pending','accepted','retracted','expired']),
 checkedAt:z.iso.datetime(),currentAccessGranted:z.literal(false),contentReturned:z.literal(false),othersReadStatus:z.literal('not-asserted'),acceptedByRoom:z.boolean(),
 messageId:id.optional(),revision:z.number().int().positive().optional(),sentAt:z.iso.datetime().optional(),expiresAt:z.iso.datetime().optional(),
 historicalAcceptanceRecorded:z.boolean().optional(),archiveCleanupState:z.enum(['not-requested','pending','recorded-complete']).optional()
}).superRefine((v,ctx)=>{
 const add=message=>ctx.addIssue({code:'custom',message});
 if(v.acceptedByRoom!==(v.state==='accepted'))add('Room acceptance must match the current receipt state');
 const fields=['messageId','revision','sentAt','expiresAt','historicalAcceptanceRecorded','archiveCleanupState'];
 if(['absent','conflict'].includes(v.state)){if(fields.some(key=>Object.hasOwn(v,key)))add('Absent or conflicting receipts cannot disclose operation metadata');}
 else if(fields.some(key=>!Object.hasOwn(v,key)))add('Existing operations require complete minimal receipt metadata');
 if(v.state==='accepted'&&v.historicalAcceptanceRecorded!==true)add('Accepted receipts require a recorded room acceptance');
});
export const chatEditSchema=z.object({operationId:id,expectedRevision:z.number().int().positive(),text:z.string().min(1).max(16000)}).strict();
export const chatPageSchema=z.object({after:z.string().regex(/^\d+$/).default('0'),limit:z.coerce.number().int().min(1).max(100).default(50),
 keyword:z.string().max(100).optional(),author:z.string().regex(/^GUID[A-Z0-9]{28}$/).optional(),from:z.iso.datetime().optional(),to:z.iso.datetime().optional(),agentGrantId:id.optional(),
 latest:z.boolean().optional(),before:z.string().regex(/^[1-9]\d*$/).optional()}).strict().superRefine((value,ctx)=>{
 if(value.before!==undefined&&!value.latest)ctx.addIssue({code:'custom',message:'An earlier window requires latest history mode.'});
 if(value.latest&&value.after!=='0')ctx.addIssue({code:'custom',message:'Latest history cannot also select a forward cursor.'});
});
export const chatDirectorySchema=z.strictObject({cursor:z.string().max(8192).nullable().optional(),limit:z.number().int().min(1).max(100).default(30)});
export const chatDirectoryCursorSchema=z.strictObject({version:z.literal(1),subjectId:z.string().regex(/^GUID[A-Z0-9]{28}$/),
 endpoint:z.string(),watermark:z.string().regex(/^\d+$/),asOf:z.number().int().positive(),expiresAt:z.number().int().positive(),
 lastOrder:z.string().regex(/^\d+$/),lastRoomId:id});
export const chatContextSchema=z.strictObject({limit:z.number().int().min(3).max(100).default(41)});
export const chatOperationReceiptSchema=z.strictObject({operationId:id,requestHash});
export const chatOperationReceiptResultSchema=chatOperationReceiptSchema.extend({roomId:id,state:z.enum(['absent','conflict','pending','acknowledged','cancelled']),
 currentAccessGranted:z.literal(false),contentReturned:z.literal(false),messageId:id.optional(),revision:z.number().int().positive().optional(),
 editedAt:z.iso.datetime().optional()}).superRefine((value,ctx)=>{
 if(['absent','conflict'].includes(value.state)&&['messageId','revision','editedAt'].some(key=>Object.hasOwn(value,key)))
  ctx.addIssue({code:'custom',message:'An absent or conflicting edit cannot expose operation metadata.'});
 if(value.state==='acknowledged'&&['messageId','revision','editedAt'].some(key=>!Object.hasOwn(value,key)))
  ctx.addIssue({code:'custom',message:'A completed edit requires its exact result metadata.'});
});
