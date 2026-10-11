import * as z from 'zod/v4';
import {summaryContentSchema} from './personal-summary-schema.mjs';
export const sharedSummaryPublishSchema=z.strictObject({
 shareId:z.uuid(),roomId:z.uuid(),expectedMemberRevision:z.number().int().positive(),
 audience:z.literal('room-authorized-members'),
 content:summaryContentSchema,agentGrantId:z.uuid().optional(),
 supersedesShareId:z.uuid().optional()
}).superRefine((v,ctx)=>{if(!v.content.fragments.length&&!v.content.keyMessageRefs.length)ctx.addIssue({code:'custom',message:'Select content or key messages'});});
export const sharedSummaryGetSchema=z.strictObject({roomId:z.uuid(),shareId:z.uuid()});
export const sharedSummaryReceiptSchema=sharedSummaryGetSchema.extend({requestHash:z.string().regex(/^[0-9a-f]{64}$/)});
export const sharedSummaryReceiptResultSchema=sharedSummaryReceiptSchema.extend({
 state:z.enum(['absent','conflict','pending','published','retracted','expired']),checkedAt:z.iso.datetime(),
 currentAccessGranted:z.literal(false),contentReturned:z.literal(false),acceptedByRoom:z.boolean(),othersReadStatus:z.literal('not-asserted'),
 messageId:z.uuid().nullable().optional(),messageState:z.enum(['not-found','pending','accepted','retracted','expired']).optional(),
 historicalAcceptanceRecorded:z.boolean().optional(),summaryContentHidden:z.boolean().optional(),noticeRetractionRecorded:z.boolean().optional(),
 noticeCleanupState:z.enum(['not-recorded','not-requested','pending','recorded-complete']).optional(),archiveScope:z.literal('shared-summary-notice-only').optional(),
}).superRefine((v,ctx)=>{
 const add=message=>ctx.addIssue({code:'custom',message});
 if(v.acceptedByRoom!==(v.state==='published'))add('Room acceptance must match the current receipt state');
 const fields=['messageId','messageState','historicalAcceptanceRecorded','summaryContentHidden','noticeRetractionRecorded','noticeCleanupState','archiveScope'];
 if(['absent','conflict'].includes(v.state)){if(fields.some(key=>Object.hasOwn(v,key)))add('Absent or conflicting receipts cannot disclose operation metadata');}
 else if(fields.some(key=>!Object.hasOwn(v,key)))add('Existing operations require complete minimal receipt metadata');
 if(v.state==='published'&&(v.messageState!=='accepted'||v.historicalAcceptanceRecorded!==true||!v.messageId))add('Published receipts require a recorded room acceptance');
});
export const sharedSummaryPageSchema=z.strictObject({roomId:z.uuid(),after:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
