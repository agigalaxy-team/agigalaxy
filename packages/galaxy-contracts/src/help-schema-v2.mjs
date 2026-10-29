import * as z from 'zod/v4';
import { searchQuerySchema } from './search-schema.mjs';
import { discoveryQuerySchema } from './discovery-schema.mjs';
import { searchV2QuerySchema } from './search-v2-schema.mjs';
import { discoveryQueryV2Schema } from './discovery-schema-v2.mjs';

export const helpPaths = Object.freeze(['continue-current-ai', 'capsule-or-history', 'open-assistance', 'bounty-or-expert']);
const short = z.string().trim().min(1).max(1200);
export const helpQuerySchema = z.strictObject({ requests: z.array(z.discriminatedUnion('kind', [
  z.strictObject({ requestId: z.uuid(), kind: z.literal('search'), input: searchQuerySchema }),
  z.strictObject({ requestId: z.uuid(), kind: z.literal('discovery'), input: discoveryQuerySchema }),
  z.strictObject({ requestId: z.uuid(), kind: z.literal('search-v2'), input: searchV2QuerySchema }),
  z.strictObject({ requestId: z.uuid(), kind: z.literal('discovery-v2'), input: discoveryQueryV2Schema }),
])).min(1).max(8).refine(rows => new Set(rows.map(row => row.requestId)).size === rows.length) });
export const helpBasisSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/), kind: z.string().min(1).max(40), id: z.string().min(1).max(160),
  sourceRevision: z.string().min(1).max(500), checkedAt: z.number().int().nonnegative(),
  locator: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null(), z.array(z.string().max(500)).max(16)])),
  classification: z.enum(['source-record', 'self-declared']), participantIds: z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16),
  capabilityVerified: z.literal(false), availability: z.literal('unknown'),
  participantIdsTruncated: z.boolean().optional(),
});
export const helpOfferDraftSchema = z.strictObject({
  id: z.uuid(), path: z.enum(helpPaths), helpDescription: short, userFacingReason: short,
  participants: z.array(z.strictObject({ id: z.string().min(1).max(160),
    kind: z.enum(['person', 'agent', 'tool', 'team', 'organization', 'service', 'unknown']), basisKey: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(16),
  interventionKinds: z.array(z.enum(['diagnosis', 'advice', 'context', 'tool', 'patch', 'review', 'takeover', 'verification'])).max(8),
  basisKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32),
  environmentDifferences: z.array(short).max(16), conditions: z.array(short).max(16),
});
export const helpOfferSchema = helpOfferDraftSchema.extend({
  generatedBy: z.literal('user-agent'), evidenceMeaning: z.literal('references-not-capability-verification'),
  availability: z.literal('unknown'), kind: z.enum(['guidance', 'source-backed-option']),
  basisRefs: z.array(helpBasisSchema).max(32), checkedAt: z.number().int().nonnegative(),
});
export const helpSessionCreateSchema = z.strictObject({
  localTaskRef: z.string().trim().min(1).max(300), caseId: z.uuid().nullable().default(null), taskId: z.uuid().nullable().default(null),
});
export const helpSessionSchema = z.strictObject({
  schemaVersion: z.literal(2), id: z.uuid(), revision: z.number().int().positive(), endpoint: z.url(),
  subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/), localTaskRef: helpSessionCreateSchema.shape.localTaskRef,
  caseId: z.uuid().nullable(), taskId: z.uuid().nullable(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  pauseState: z.enum(['active', 'paused', 'returned']),
  basis: z.array(helpBasisSchema).max(200), offers: z.array(helpOfferSchema).max(32),
  selectedHelpIds: z.array(z.uuid()).max(32),
  queries: z.array(z.strictObject({ requestId: z.uuid(), kind: z.enum(['search', 'discovery', 'search-v2', 'discovery-v2']),
    state: z.enum(['ready', 'empty', 'failed', 'unavailable']), checkedAt: z.number().int().nonnegative(),
    basisKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(40),
    request: helpQuerySchema.shape.requests.element.optional(),
  })).max(32),
  linkedOperations: z.array(z.strictObject({ operationId: z.uuid(), taskId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['submitting', 'unknown', 'acknowledged', 'absent', 'conflict']),
    version: z.number().int().positive().optional(), checkedAt: z.number().int().nonnegative(),
  })).max(32),
  actionOperations: z.array(z.strictObject({ operationId: z.uuid(), kind: z.enum(['publish-task', 'task-event', 'participation-propose', 'participation-event', 'context-grant', 'context-event']),
    taskId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['prepared', 'submitting', 'unknown', 'acknowledged', 'absent', 'conflict']),
    checkedAt: z.number().int().nonnegative(), participationId: z.uuid().optional(), grantId: z.uuid().optional(),
  })).max(128).default([]),
  selectionEffect: z.literal('local-choice-only'), cloudSync: z.literal('off'),
});

export const helpActionPrepareSchema = z.strictObject({
  kind: z.enum(['publish-task', 'task-event', 'participation-propose', 'participation-event', 'context-grant', 'context-event']),
  payloadJson: z.string().min(2).max(40000), taskId: z.uuid().optional(), participationId: z.uuid().optional(), offerId: z.uuid().optional(),
  recipientIds: z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16).optional(),
  authorizationRequestId: z.uuid().optional(),
});
export const helpActionExecuteSchema = z.strictObject({ operationId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), authorizationRequestId: z.uuid().optional() });
