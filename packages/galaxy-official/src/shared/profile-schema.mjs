import * as z from 'zod/v4';
import { projectDescriptionSchema } from './discovery-schema.mjs';

export const selfDeclaredProfileSchema=z.strictObject({
  displayName:z.string().trim().max(100).optional(),
  about:z.string().trim().max(2000).optional(),
  claimedCapabilities:z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  projects:z.array(projectDescriptionSchema).max(10).refine(values=>new Set(values.map(value=>value.id)).size===values.length).optional(),
});
export const profileStatementSchema=z.strictObject({
  id:z.uuid(),expectedRevision:z.number().int().nonnegative(),selfDeclared:selfDeclaredProfileSchema,
});
