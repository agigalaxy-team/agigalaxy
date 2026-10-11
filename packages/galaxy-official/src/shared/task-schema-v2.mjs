import * as z from 'zod/v4';
import { capabilityIdSchema, qualificationEvidenceSchema } from './qualification-schema.mjs';
import {qualificationEvidenceV2Schema} from './qualification-v2-schema.mjs';
import {taskTextSchema,taskMaterialDescriptorSchema,taskMaterialReferenceIssue} from './task-material-v1-schema.mjs';

const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const note = z.string().trim().min(1).max(1500);
// Retain both parts of an existing help proposal without truncation or a
// second request for the same description (1500 + two newlines + 1500).
const workDescription = z.string().trim().min(1).max(3002);
const positive = z.number().int().positive();
export const taskFactRefSchema = z.strictObject({ id: z.uuid(), version: positive });
const amount = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/);
function decimal(value) { const [whole, part = ''] = value.split('.'); return BigInt(whole) * 100000000n + BigInt(part.padEnd(8, '0')); }
const budget = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fixed'), amount, unit: z.string().trim().min(1).max(24) }),
  z.strictObject({ mode: z.literal('range'), minimum: amount, maximum: amount, unit: z.string().trim().min(1).max(24) })
    .refine(v => decimal(v.minimum) <= decimal(v.maximum)),
  z.strictObject({ mode: z.literal('quote'), unit: z.string().trim().min(1).max(24) }),
]);
export const taskRequestV2Schema = z.strictObject({
  operationId: z.uuid(), taskId: z.uuid(), caseId: z.uuid().nullable().default(null),
  parentTaskId: z.uuid().optional(),
  intent: z.enum(['stuck', 'proactive-review', 'diagnosis', 'collaboration', 'delegation']),
  workContext: z.strictObject({ goal: taskTextSchema(10000), currentSituation: taskTextSchema(10000), attemptRefs: z.array(taskFactRefSchema).max(32).default([]) }),
  title: taskTextSchema(120,{single:true}), summary: taskTextSchema(10000), expectedOutcome: taskTextSchema(1500).optional(),
  materials: z.array(taskMaterialDescriptorSchema).min(1).max(8).optional(),
  visibility: z.enum(['Public', 'Private']), collaboration: z.enum(['open-assistance', 'basic-bounty']),
  budget: budget.optional(), capabilityId: capabilityIdSchema.optional(),
  qualification: z.strictObject({ policyId: z.string().min(1).max(80), policyVersion: z.string().min(1).max(32),profile:z.literal('facts-v2').optional() }).optional(),
  enrollmentExpiresAt: positive,
}).refine(v => (v.collaboration === 'basic-bounty' ? !!v.budget && !!v.capabilityId && !!v.qualification : v.budget === undefined)
  && (!v.qualification || !!v.capabilityId)).refine(v=>taskMaterialReferenceIssue(v)===null,{message:'Task material references must match descriptors.'});

const taskCommon = { eventId: z.uuid(), expectedTaskVersion: positive };
export const taskEventV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...taskCommon, kind: z.literal('suggest-contacts'), state: z.enum(['ready', 'empty', 'failed']),
    items: z.array(z.strictObject({ subjectId: subject, help: note, basis: note,
      sourceRefs: z.array(z.string().min(1).max(500)).max(16), conditions: note.optional() })).max(32), error: note.optional() }),
  z.strictObject({ ...taskCommon, kind: z.literal('invite'), recipientId: subject, note, expiresAt: positive }),
  z.strictObject({ ...taskCommon, kind: z.literal('invitation-reply'), invitationId: z.uuid(), response: z.enum(['question', 'interested', 'declined']), message: note }),
  z.strictObject({ ...taskCommon, kind: z.literal('revoke-invitation'), invitationId: z.uuid(), reason: note }),
  z.strictObject({ ...taskCommon, kind: z.literal('apply'), proposal: note, scope: note.optional(), quote: budget.optional(), qualificationEvidence: z.union([qualificationEvidenceSchema,qualificationEvidenceV2Schema]).optional() }),
  z.strictObject({ ...taskCommon, kind: z.literal('withdraw-application'), applicationId: z.uuid(), reason: note }),
  z.strictObject({ ...taskCommon, kind: z.literal('cancel'), reason: note }),
  z.strictObject({ ...taskCommon, kind: z.literal('close'), reason: note }),
  z.strictObject({ ...taskCommon, kind: z.literal('extend-enrollment'), enrollmentExpiresAt: positive }),
]);
export const taskEnvelopeV2Schema = z.strictObject({ taskId: z.uuid(), event: taskEventV2Schema });
export const participationProposalV2Schema = z.strictObject({ ...taskCommon,
  kind: z.literal('propose'), participationId: z.uuid(), subjectId: subject,
  role: z.enum(['contribution', 'diagnosis', 'advice', 'context', 'tool', 'patch', 'review', 'verification', 'takeover', 'main-responsible']),
  scopeVersion: z.literal(1), agreedScope: workDescription, applicationId: z.uuid().optional(),
});
const participationCommon = { eventId: z.uuid(), expectedParticipationVersion: positive };
export const participationEventV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({...participationCommon,kind:z.literal('requester-feedback'),descriptionClarity:z.enum(['clear','partly-clear','unclear']),
    scopeMatched:z.boolean(),note,supersedes:z.uuid().optional(),reason:note.optional()}),
  z.strictObject({ ...participationCommon, kind: z.literal('confirm'), scopeVersion: positive }),
  z.strictObject({ ...participationCommon, kind: z.literal('decline'), reason: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('withdraw'), reason: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('propose-scope'), scopeVersion: positive, agreedScope: workDescription, reason: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('confirm-scope'), proposalId: z.uuid() }),
  z.strictObject({ ...participationCommon, kind: z.literal('decline-scope'), proposalId: z.uuid(), reason: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('deliver'), resultRef: taskFactRefSchema,
    interventionRefs: z.array(taskFactRefSchema).max(32), evidenceRefs: z.array(z.union([z.uuid(),taskFactRefSchema])).max(32), summary: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('accept'), deliveryId: z.uuid(), summary: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('dispute'), reason: note }),
  z.strictObject({ ...participationCommon, kind: z.literal('propose-resolution'), summary: note, outcome: z.enum(['close', 'resume-work']) }),
  z.strictObject({ ...participationCommon, kind: z.literal('confirm-resolution'), proposalId: z.uuid() }),
]);
export const taskReceiptV2Schema = z.strictObject({ taskId: z.uuid(), eventId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const taskQueryV2Schema = z.strictObject({ view: z.enum(['open', 'requested', 'participating']).default('open'),
  query: z.string().trim().max(200).default(''), after: z.uuid().optional(), limit: z.number().int().min(1).max(40).default(12) });
