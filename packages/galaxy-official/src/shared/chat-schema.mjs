import * as z from 'zod/v4';
import {attachmentReferenceSchema} from './chat-attachments-schema.mjs';
const id=z.uuid();
export const chatCreateSchema=z.object({roomId:id,operationId:id,title:z.string().trim().min(1).max(120),
 kind:z.enum(['ordinary','ai-subzone']).default('ordinary'),parentRoomId:id.optional(),
 taskRefs:z.array(id).max(20).default([]),retentionDays:z.union([z.literal(7),z.literal(30),z.literal(90)]).default(90)}).strict();
export const chatDecisionSchema=z.object({decisionId:id,expectedRevision:z.number().int().positive(),
 action:z.enum(['invite','remove','retention','become-owner','transfer-owner','persistent','dissolve']),
 targetSubjectId:z.string().regex(/^GUID[A-Z0-9]{28}$/).optional(),retentionDays:z.union([z.literal(7),z.literal(30),z.literal(90)]).optional(),persistent:z.boolean().optional()}).strict();
// Optional without a default preserves canonical payloads of all old messages.
export const chatSendSchema=z.object({clientMessageId:id,text:z.string().min(1).max(16000),replyTo:id.nullable().default(null),agentGrantId:id.optional(),attachments:z.array(attachmentReferenceSchema).min(1).max(16).optional()}).strict();
export const chatEditSchema=z.object({operationId:id,expectedRevision:z.number().int().positive(),text:z.string().min(1).max(16000)}).strict();
export const chatPageSchema=z.object({after:z.string().regex(/^\d+$/).default('0'),limit:z.coerce.number().int().min(1).max(100).default(50),
 keyword:z.string().max(100).optional(),author:z.string().regex(/^GUID[A-Z0-9]{28}$/).optional(),from:z.iso.datetime().optional(),to:z.iso.datetime().optional(),agentGrantId:id.optional()}).strict();
