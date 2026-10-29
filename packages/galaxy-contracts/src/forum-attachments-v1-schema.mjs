import * as z from 'zod/v4';
const uuid=z.uuid();
export const forumAttachmentReferenceSchema=z.strictObject({id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const forumAttachmentReferencesSchema=z.array(forumAttachmentReferenceSchema).max(4).refine(values=>new Set(values.map(value=>value.id)).size===values.length);
export const forumAttachmentPrepareSchema=z.strictObject({attachmentId:uuid,name:z.string().trim().min(1).max(255).refine(value=>{for(const character of value){const code=character.charCodeAt(0);if(code<32||code===127)return false;}return true;}),mediaType:z.string().min(1).max(120).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),size:z.number().int().positive().max(33554432),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const forumAttachmentReadSchema=z.strictObject({attachmentId:uuid});
export const forumAttachmentSourceSchema=z.union([z.strictObject({postId:uuid,versionId:uuid}),z.strictObject({replyId:uuid})]);
export const forumAttachmentContentSchema=z.strictObject({attachmentId:uuid,source:forumAttachmentSourceSchema});
export const forumAttachmentQuerySchema=z.strictObject({after:uuid.optional(),limit:z.number().int().min(1).max(30).default(20)});
