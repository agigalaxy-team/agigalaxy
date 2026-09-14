import * as z from 'zod/v4';
const id=z.uuid(),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().trim().min(1).max(1600);
export const outcomeMaterialRef=z.strictObject({kind:z.literal('outcome-material'),id,version:z.literal(1)});
export const outcomeMaterialSource=z.strictObject({kind:z.enum(['message','attachment']),id,version:z.number().int().positive(),sha256:hash,roomId:id});
export const outcomeMaterialAudience=z.strictObject({visibility:z.enum(['Private','Public']),viewers:z.array(subject).max(16).default([])});
export const outcomeMaterialSelectionSchema=z.strictObject({kind:z.enum(['message','attachment']),id,version:z.number().int().positive().default(1)});
export const outcomeMaterialRequestSchema=z.strictObject({id,materialId:id,kind:z.literal('request'),source:outcomeMaterialSource,
 caseId:id,taskId:id.optional(),participationId:id.optional(),purpose:text,title:z.string().trim().min(1).max(160),
 audience:outcomeMaterialAudience,uses:z.array(z.enum(['evidence','capsule-publication'])).min(1).max(2),
 retention:z.literal('with-related-result; independently-authorized-copy'),requestExpiresAt:z.iso.datetime()});
export const outcomeMaterialApproveSchema=z.strictObject({id,materialId:id,kind:z.literal('approve'),expectedRevision:z.number().int().positive(),
 requestHash:hash,source:outcomeMaterialSource,license:z.string().trim().min(1).max(80),basis:z.enum(['authored-content','documented-covering-license']),
 licenseReference:z.string().trim().min(1).max(1600).optional(),scope:text,expiresAt:z.iso.datetime().optional(),
 independentRetention:z.literal(true),temporarySourceExpiryRevokesCopy:z.literal(false)}).refine(x=>x.basis!=='documented-covering-license'||!!x.licenseReference);
export const outcomeMaterialControlSchema=z.strictObject({id,materialId:id,kind:z.enum(['decline','cancel','revoke']),
 expectedRevision:z.number().int().positive(),reason:text});
export const outcomeMaterialEventSchema=z.union([outcomeMaterialRequestSchema,outcomeMaterialApproveSchema,outcomeMaterialControlSchema]);
export const outcomeMaterialReadSchema=z.strictObject({id,version:z.literal(1).default(1)});
export const outcomeMaterialQuerySchema=z.strictObject({view:z.enum(['requested','authored']).default('requested'),after:id.optional(),limit:z.number().int().min(1).max(50).default(20)});
export const outcomeMaterialReceiptSchema=z.strictObject({operationId:id,payloadHash:hash});
