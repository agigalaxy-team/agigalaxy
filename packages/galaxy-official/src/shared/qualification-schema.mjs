import * as z from 'zod/v4';
export const capabilityIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/);
export const qualificationPolicySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/), version: z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/),
  capabilityId: capabilityIdSchema, title: z.string().trim().min(1).max(160),
  collaboration: z.enum(['open-assistance','basic-bounty']), notBefore: z.number().int().nonnegative(), notAfter: z.number().int().positive(),
  minProofs: z.number().int().min(0).max(16), minAcceptedCollaborations: z.number().int().min(0).max(16),
  historyWindowSeconds: z.number().int().min(1).max(31536000), requireCiSuccess: z.boolean(),
  repositories: z.array(z.strictObject({ owner: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/) })).max(16)
}).refine(value => value.notAfter > value.notBefore && (value.collaboration !== 'basic-bounty' || value.minAcceptedCollaborations >= 1)
  && (value.minProofs === 0 || value.repositories.length > 0));
export const qualificationEvidenceSchema = z.strictObject({ proofIds: z.array(z.uuid()).max(16), assistanceIds: z.array(z.uuid()).max(16) })
  .refine(value => new Set(value.proofIds).size===value.proofIds.length && new Set(value.assistanceIds).size===value.assistanceIds.length);
export const qualificationQuerySchema = z.strictObject({ policyId: z.string().min(1).max(80), policyVersion: z.string().min(1).max(32),
  capabilityId: capabilityIdSchema, subjectId: z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(), evidence: qualificationEvidenceSchema });
