import * as z from 'zod/v4';

const text = z.string().trim().min(1).max(1200);
const ref = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);
const common = { id: z.uuid(), caseId: z.uuid(), expectedVersion: z.number().int().min(1) };
export const caseEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('case'), id: z.uuid(), localRef: ref, title: z.string().trim().min(1).max(160),
    summary: text, source: z.strictObject({ kind: z.enum(['local', 'bridge', 'hub']), reference: ref }),
    participants: z.array(z.strictObject({ subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/),
      role: z.enum(['requester', 'provider', 'contributor']) })).min(1).max(16) }),
  z.strictObject({ ...common, kind: z.literal('attempt'), sequence: z.number().int().positive(),
    approach: text, configuration: z.strictObject({ environment: z.string().min(1).max(160),
      version: z.string().min(1).max(80), tools: z.array(z.string().min(1).max(80)).max(16) }) }),
  z.strictObject({ ...common, kind: z.literal('result'), attemptId: z.uuid(),
    outcome: z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']), summary: text,
    failureReason: z.string().max(1200), limitations: z.array(z.string().min(1).max(400)).max(16) }),
  z.strictObject({ ...common, kind: z.literal('revision'), correctsEventId: z.uuid(), reason: text, summary: text,
    review: z.strictObject({ threadId: z.uuid(), type: z.enum(['correction', 'dispute']),
      state: z.enum(['opened', 'in-review', 'resolved', 'rejected', 'reopened']) }).optional() }),
  z.strictObject({ ...common, kind: z.literal('withdrawal'), reason: text }),
]);

// v1 stays strict and unchanged. v2 records actual work without manufacturing
// an Attempt for advice-only interventions. References identify immutable versions.
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const factReferenceSchema = z.strictObject({ id: z.uuid(), version: z.number().int().positive() });
const outcome = z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']);
const terminal = z.enum(['completed', 'abandoned', 'canceled', 'inconclusive']);
const factCommon = {
  schemaVersion: z.literal(2).optional(), eventId: z.uuid(), caseId: z.uuid(),
  expectedVersion: z.number().int().positive(), actorId: subject,
  taskId: z.uuid().nullable().optional(), participationId: z.uuid().nullable().optional(),
  taskScopeVersion: z.number().int().positive().optional(),
  participationScopeVersion: z.number().int().positive().optional(),
};
const sourceReference = z.strictObject({ kind: z.enum(['attempt', 'intervention', 'result', 'evidence', 'selected-message', 'configuration', 'outcome-material']),
  id: z.uuid(), version: z.number().int().positive() });
const interventionFields = {
  types: z.array(z.enum(['diagnosis', 'advice', 'context-addition', 'tool-introduction', 'patch', 'review',
    'takeover', 'verification', 'scope-clarification', 'multi-node-collaboration'])).min(1).max(12),
  affectsAttemptIds: z.array(z.uuid()).max(32), description: text,
  sourceRefs: z.array(sourceReference).max(32), observedEffect: text,
};
export const caseEventV2Schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...factCommon, kind: z.literal('case-created'), expectedVersion: z.literal(0),
    localRef: ref, title: z.string().trim().min(1).max(160), summary: text,
    source: z.strictObject({ kind: z.enum(['local', 'bridge', 'hub', 'active-task']), reference: ref }), synthetic: z.boolean() }),
  z.strictObject({ ...factCommon, kind: z.literal('attempt-start'), role: z.string().min(1).max(120), strategy: text,
    configurationRef: factReferenceSchema.nullable().optional(),
    environment: z.strictObject({ name: z.string().min(1).max(160), version: z.string().min(1).max(80) }).optional(),
    inputScopeSummary: text, permissionScope: z.array(z.string().min(1).max(160)).min(1).max(32),
    startedAt: z.iso.datetime().optional() }),
  z.strictObject({ ...factCommon, kind: z.literal('attempt-end'), attemptRef: factReferenceSchema,
    status: terminal, summary: text, reportedOutcome: outcome.optional(), failureReason: text,
    endedAt: z.iso.datetime().optional() }),
  z.strictObject({ ...factCommon, kind: z.literal('attempt-correct'), attemptRef: factReferenceSchema,
    status: terminal, summary: text, reportedOutcome: outcome.optional(), failureReason: text, reason: text }),
  z.strictObject({ ...factCommon, kind: z.literal('intervention'), ...interventionFields,
    supersedes: factReferenceSchema.nullable().optional() }),
  z.strictObject({ ...factCommon, kind: z.literal('intervention-response'), interventionRef: factReferenceSchema,
    state: z.enum(['accepted', 'partial', 'disputed']), summary: text }),
  z.strictObject({ ...factCommon, kind: z.literal('result-recorded'),
    origin: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('attempt'), ...factReferenceSchema.shape }),
      z.strictObject({ kind: z.literal('intervention'), ...factReferenceSchema.shape }),
    ]), scopeVersion: z.number().int().positive(), deliverableRefs: z.array(sourceReference).max(32),
    reportedOutcome: outcome, summary: text, limitations: text,
    supersedes: factReferenceSchema.nullable().optional() }),
  z.strictObject({ ...factCommon, kind: z.literal('resolution-recorded'), taskScopeVersion: z.number().int().positive(),
    status: z.enum(['unresolved', 'partially-resolved', 'resolved', 'inconclusive', 'regressed']), summary: text,
    satisfiedGoals: z.array(text).max(32), remainingGoals: z.array(text).max(32),
    resultRefs: z.array(factReferenceSchema).max(32), verificationRefs: z.array(factReferenceSchema).max(32),
    supersedesResolutionId: z.uuid().nullable() }),
  z.strictObject({ ...factCommon, kind: z.literal('case-scope-revised'), taskScopeVersion: z.number().int().positive(),
    summary: text, reason: text }),
  z.strictObject({ ...factCommon, kind: z.literal('case-withdrawn'), reason: text }),
]);

export const caseTaskLinkSchema = z.strictObject({ operationId: z.uuid(), taskId: z.uuid(),
  expectedTaskVersion: z.number().int().positive(), case: z.strictObject({ consentId: z.uuid(), payloadJson: z.string() }),
  initialFact: z.strictObject({ consentId: z.uuid(), payloadJson: z.string() }) });

