import * as z from 'zod/v4';
import { discoveryPreferencesSchema } from './discovery-schema.mjs';
export const notificationIdSchema = z.string().regex(/^(assistance|context|context-accept|capsule|incident):[0-9a-f-]{36}$/).refine(value => z.uuid().safeParse(value.split(':')[1]).success);
export const notificationSettingsSchema = z.strictObject({ enabled: z.boolean(), invitations: z.boolean(),
  collaboration: z.boolean(), materials: z.boolean(), capsules: z.boolean().default(true), incidents: z.boolean().default(true), mutedAssistanceIds: z.array(z.uuid()).max(64),
  discovery: discoveryPreferencesSchema.optional()
}).refine(value => new Set(value.mutedAssistanceIds).size === value.mutedAssistanceIds.length);
export const notificationQuerySchema = z.strictObject({ limit: z.number().int().min(1).max(20).default(8),
  unreadOnly: z.boolean().default(false), after: notificationIdSchema.optional() });
export const notificationArchiveSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), before: z.number().int().positive() });
export const defaultNotificationSettings = Object.freeze({ enabled: true, invitations: true, collaboration: true, materials: true, capsules: true, incidents: true, mutedAssistanceIds: [] });
