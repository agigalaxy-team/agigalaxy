import { capabilityIdSchema, qualificationEvidenceSchema } from './qualification-schema.mjs';
import * as z from 'zod/v4';
export * from './task-schema-v2.mjs';
// Only the author's contribution facts may be explicitly shared from a public
// request. Applications, selection lists, invitations and Context stay separate.
export const publicContributionEventKinds=Object.freeze(['confirm','change-scope','confirm-scope','deliver','accept','cancel','dispute','propose-resolution','confirm-resolution','requester-feedback']);

export const assistanceReceiptSchema = z.object({ assistanceId: z.uuid(), eventId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

const text = z.string().trim().min(1).max(1200);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/);
const budget = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fixed'), amount, unit: z.string().trim().min(1).max(24) }),
  z.strictObject({ mode: z.literal('range'), minimum: amount, maximum: amount, unit: z.string().trim().min(1).max(24) })
    .refine(value => decimal(value.minimum) <= decimal(value.maximum)),
  z.strictObject({ mode: z.literal('quote'), unit: z.string().trim().min(1).max(24) })
]);
function decimal(value) { const [whole, part = ''] = value.split('.'); return BigInt(whole) * 100000000n + BigInt(part.padEnd(8, '0')); }
export const assistanceRequestSchema = z.strictObject({ id: z.uuid(), caseId: z.uuid(), title: z.string().trim().min(1).max(160),
  problem: text, attemptedApproaches: z.array(text).max(8), scope: text, visibility: z.enum(['Private', 'Public']),
  collaboration: z.enum(['open-assistance', 'basic-bounty']), budget: budget.optional(), capabilityId: capabilityIdSchema.optional(),
  qualification: z.strictObject({ policyId: z.string().min(1).max(80), policyVersion: z.string().min(1).max(32) }).optional(),
  enrollmentExpiresAt: z.number().int().positive()
}).refine(value => (value.collaboration === 'basic-bounty' ? !!value.budget : value.budget === undefined) && (!value.qualification || !!value.capabilityId));
const common = { id: z.uuid(), expectedVersion: z.number().int().positive() };
export const assistanceEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('requester-feedback'), descriptionClarity: z.enum(['clear', 'partly-clear', 'unclear']), scopeMatched: z.boolean(), note: z.string().trim().min(1).max(300) }),
  z.strictObject({ ...common, kind: z.literal('invite'), participantId: z.string().regex(/^GUID[0-9A-Z]{28}$/), note: z.string().trim().min(1).max(300) }),
  z.strictObject({ ...common, kind: z.literal('offer'), proposal: text, scope: text, quote: budget.optional(), qualificationEvidence: qualificationEvidenceSchema.optional() }),
  z.strictObject({ ...common, kind: z.literal('withdraw-offer'), offerId: z.uuid(), reason: text }),
  z.strictObject({ ...common, kind: z.literal('shortlist'), offerIds: z.array(z.uuid()).max(16) }),
  z.strictObject({ ...common, kind: z.literal('select'), offerId: z.uuid() }),
  z.strictObject({ ...common, kind: z.literal('confirm') }),
  z.strictObject({ ...common, kind: z.literal('change-scope'), scope: text, reason: text }),
  z.strictObject({ ...common, kind: z.literal('confirm-scope') }),
  z.strictObject({ ...common, kind: z.literal('deliver'), attemptId: z.uuid(), summary: text, evidenceIds: z.array(z.uuid()).max(16),caseReviewVersion:z.number().int().min(0).max(1000).optional() }),
  z.strictObject({ ...common, kind: z.literal('accept'), deliveryId: z.uuid(), summary: text }),
  z.strictObject({ ...common, kind: z.literal('cancel'), reason: text }),
  z.strictObject({ ...common, kind: z.literal('expire') }),
  z.strictObject({ ...common, kind: z.literal('dispute'), reason: text }),
  z.strictObject({ ...common, kind: z.literal('propose-resolution'), summary: text,outcome:z.enum(['close','resume-work']).optional() }),
  z.strictObject({ ...common, kind: z.literal('confirm-resolution'), proposalId: z.uuid() })
]);

export const assistanceEnvelopeSchema = z.strictObject({ assistanceId: z.uuid(), event: assistanceEventSchema });

export const assistanceQuerySchema = z.strictObject({
  view: z.enum(['open', 'requested', 'participating', 'requester-history']).default('open'),
  query: z.string().trim().max(200).default(''), requesterId: z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),
  after: z.uuid().optional(), limit: z.number().int().min(1).max(20).default(8)
});

export const requesterHistorySchema = z.strictObject({ subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),
  after: z.uuid().optional(), limit: z.number().int().min(1).max(20).default(8) });
export const requesterHistoryFactsSchema = z.strictObject({ assistanceId: z.uuid(), after: z.uuid().optional(),
  limit: z.number().int().min(1).max(20).default(8) });
// Preserve semicolon-separated legacy draft text and newer array-based edits.
export function assistanceDraftApproaches(content){
  return Array.isArray(content.attemptedApproaches)?[...content.attemptedApproaches]
    :String(content.values.attempts??'').split(/[;；]/).map(value=>value.trim()).filter(Boolean);
}
