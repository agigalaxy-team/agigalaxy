import * as z from 'zod/v4';
import { selectedTextSchema } from './context-schema.mjs';
const uuid = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const contextGrantV2Schema = z.object({
  schemaVersion: z.literal(2), id: uuid, taskId: uuid, participationId: uuid, participantId: subject,
  scopeVersion: z.number().int().positive(), scopeEventId: uuid, expiresAt: z.number().int().positive(),
  materials: z.array(z.object({ id: uuid, label: z.string().trim().min(1).max(160),
    mediaType: z.literal('text/plain'), content: selectedTextSchema.refine(value => value.length > 0),
  }).strict()).min(1).max(8).refine(items => new Set(items.map(item => item.id)).size === items.length),
}).strict();
export const contextEventV2Schema = z.object({
  schemaVersion: z.literal(2), id: uuid, grantId: uuid, taskId: uuid, participationId: uuid,
  scopeVersion: z.number().int().positive(), materialsHash: hash, kind: z.enum(['accept','decline','revoke']),
}).strict();
export const contextReceiptV2Schema = z.object({ grantId: uuid, eventId: uuid, payloadHash: hash }).strict();
export const contextQueryV2Schema = z.object({ taskId: uuid, participationId: uuid.optional(),
  after: uuid.optional(), limit: z.number().int().min(1).max(50).default(20),
}).strict();
