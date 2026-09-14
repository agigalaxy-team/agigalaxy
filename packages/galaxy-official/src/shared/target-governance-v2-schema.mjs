import * as z from 'zod/v4';

export const governanceTargetSchemaV2 = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('task'), id: z.uuid(), version: z.number().int().positive(), rootEventId: z.uuid() }),
  z.strictObject({ type: z.literal('room'), id: z.uuid(), version: z.number().int().positive() }),
]);
export const governanceScopeSchemaV2 = z.enum(['discovery-hidden', 'new-participation-paused', 'sending-paused', 'invitations-paused']);
export const targetReportSchemaV2 = z.strictObject({
  schemaVersion: z.literal(2), id: z.uuid(), target: governanceTargetSchemaV2,
  category: z.enum(['advertising', 'harassment', 'privacy', 'misrepresentation', 'other']),
  summary: z.string().trim().min(1).max(1600),
});
const common = { schemaVersion: z.literal(2), id: z.uuid(), reportId: z.uuid(), expectedVersion: z.number().int().positive(), summary: z.string().trim().min(1).max(1600) };
const scopeFields = { scopes: z.array(governanceScopeSchemaV2).min(1).max(2).refine(x => new Set(x).size === x.length), until: z.number().int().positive(), targetVersion: z.number().int().positive(), rule: z.string().trim().min(1).max(120) };
export const targetModerationSchemaV2 = z.discriminatedUnion('kind', [
  ...['supplement', 'appeal', 'withdraw-report', 'resume', 'review'].map(kind => z.strictObject({ ...common, kind: z.literal(kind) })),
  z.strictObject({ ...common, kind: z.literal('pause'), ...scopeFields }),
  z.strictObject({ ...common, kind: z.literal('resolve'), verdict: z.enum(['upheld', 'dismissed']), rule: scopeFields.rule,
    targetVersion: scopeFields.targetVersion, restriction: z.strictObject({ scopes: scopeFields.scopes, until: scopeFields.until }).nullable() }),
]);
export const targetGovernanceReceiptSchemaV2 = z.strictObject({ eventId: z.uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const targetGovernanceQuerySchemaV2 = z.strictObject({ after: z.uuid().optional(), limit: z.number().int().min(1).max(40).default(20), target: z.strictObject({ type: z.enum(['task','room']), id: z.uuid() }).optional() });
