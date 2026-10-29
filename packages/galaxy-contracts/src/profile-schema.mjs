import * as z from 'zod/v4';
import { projectDescriptionSchema, functionTagsSchema } from './discovery-schema.mjs';

// A plain project introduction need not opt into functional discovery. Keep
// discovery's original required tags for projects that actually opt in.
const profileProjectSchema=projectDescriptionSchema.safeExtend({functions:functionTagsSchema.default([])})
  .refine(project=>!project.discoverable||project.functions.length>0);

export const selfDeclaredProfileSchema=z.strictObject({
  displayName:z.string().trim().max(100).optional(),
  about:z.string().trim().max(2000).optional(),
  claimedCapabilities:z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  projects:z.array(profileProjectSchema).max(10).refine(values=>new Set(values.map(value=>value.id)).size===values.length).optional(),
});
export const profileSharingSchema=z.strictObject({visibility:z.enum(['Private','Public']),
  viewers:z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16).refine(ids=>new Set(ids).size===ids.length),
  expiresAt:z.number().int().positive().nullable(),
}).refine(sharing=>sharing.visibility!=='Public'||sharing.viewers.length===0);
export const profileStatementSchema=z.strictObject({
  id:z.uuid(),expectedRevision:z.number().int().nonnegative(),selfDeclared:selfDeclaredProfileSchema,sharing:profileSharingSchema.optional(),
});
export const profileReceiptLocatorSchema=z.strictObject({operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
