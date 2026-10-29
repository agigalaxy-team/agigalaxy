import * as z from 'zod/v4';
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const bindingQuerySchema=z.strictObject({after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(20),
  bindingId:z.uuid().optional(),installationId:z.uuid().optional()});
export const managedBindingSchema=z.strictObject({bindingId:z.uuid(),installationId:z.uuid(),scopes:z.array(z.string().min(1).max(100)).max(64),
  createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),revokedAt:z.iso.datetime().nullable(),state:z.enum(['active','expired','revoked'])});
export const bindingPageSchema=z.strictObject({subjectId:subject,currentBindingId:z.uuid(),checkedAt:z.number().int().nonnegative(),
  items:z.array(managedBindingSchema).max(20),nextAfter:z.uuid().nullable()});
