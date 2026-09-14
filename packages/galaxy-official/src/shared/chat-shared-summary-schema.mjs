import * as z from 'zod/v4';
import {summaryContentSchema} from './personal-summary-schema.mjs';
export const sharedSummaryPublishSchema=z.strictObject({
 shareId:z.uuid(),roomId:z.uuid(),expectedMemberRevision:z.number().int().positive(),
 audience:z.literal('room-authorized-members'),
 content:summaryContentSchema,agentGrantId:z.uuid().optional(),
 supersedesShareId:z.uuid().optional()
}).superRefine((v,ctx)=>{if(!v.content.fragments.length&&!v.content.keyMessageRefs.length)ctx.addIssue({code:'custom',message:'Select content or key messages'});});
export const sharedSummaryGetSchema=z.strictObject({roomId:z.uuid(),shareId:z.uuid()});
export const sharedSummaryPageSchema=z.strictObject({roomId:z.uuid(),after:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
