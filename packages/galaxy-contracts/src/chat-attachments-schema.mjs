import * as z from 'zod/v4';
export const attachmentPolicySchema=z.strictObject({version:z.literal(1),maxFileBytes:z.number().int().min(1).max(67108864),
 maxSubjectBytes:z.number().int().positive(),maxGlobalBytes:z.number().int().positive(),maxFilesPerMessage:z.number().int().min(1).max(16)});
export const defaultAttachmentPolicy=attachmentPolicySchema.parse({version:1,maxFileBytes:10485760,maxSubjectBytes:67108864,maxGlobalBytes:10737418240,maxFilesPerMessage:4});
export const attachmentPrepareSchema=z.strictObject({attachmentId:z.uuid(),roomId:z.uuid(),
 name:z.string().trim().min(1).max(180).refine(v=>!Array.from(v).some(character=>{const code=character.codePointAt(0);return code!==undefined&&(code<=0x1f||code===0x7f)||character==='/'||character==='\\';})&&!['.','..'].includes(v)),
 mediaType:z.string().max(120).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
 size:z.number().int().min(1).max(67108864),sha256:z.string().regex(/^[a-f0-9]{64}$/),
 purpose:z.literal('temporary-room-attachment'),confirmed:z.literal(true),agentGrantId:z.uuid().optional()});
export const attachmentReferenceSchema=z.strictObject({id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const attachmentReadSchema=z.strictObject({attachmentId:z.uuid(),agentGrantId:z.uuid().optional()});
export const attachmentQuerySchema=z.strictObject({roomId:z.uuid(),after:z.uuid().optional(),limit:z.number().int().min(1).max(100).default(50)});
