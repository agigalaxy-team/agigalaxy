import * as z from 'zod/v4';
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
// Selected text excerpts only. Known credential formats are rejected, not redacted silently.
const secret = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:Bearer\s+[A-Za-z0-9_.~-]{16,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})|(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s]{8,}/i;
export const selectedTextSchema = z.string().max(4000).refine(value => !secret.test(value), 'Credential material is not accepted.');
export const contextReceiptSchema = z.object({kind:z.enum(['grant','accept']),grantId:z.uuid(),eventId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
  .refine(value=>value.kind!=='grant'||value.eventId===value.grantId);
export const contextGrantSchema = z.strictObject({
  id: z.uuid(), assistanceId: z.uuid(), caseId: z.uuid(), participantId: subject,
  scope: z.string().trim().min(1).max(1200), scopeEventId: z.uuid(), expiresAt: z.number().int().positive(),
  materials: z.array(z.strictObject({ id: z.uuid(), label: z.string().trim().min(1).max(160),
    mediaType: z.literal('text/plain'), content: selectedTextSchema.refine(value => value.length > 0) })).min(1).max(8)
}).refine(value => new Set(value.materials.map(item => item.id)).size === value.materials.length);
export const contextAcceptanceSchema = z.strictObject({ id: z.uuid(), grantId: z.uuid(), assistanceId: z.uuid(),
  scopeEventId: z.uuid(), materialsHash: z.string().regex(/^[a-f0-9]{64}$/) });
export function contextScopeEvent(state) {
  return [...(state.events ?? [])].reverse().find(row => ['select', 'confirm', 'change-scope', 'confirm-scope'].includes(row.event.kind))?.event.id ?? null;
}
