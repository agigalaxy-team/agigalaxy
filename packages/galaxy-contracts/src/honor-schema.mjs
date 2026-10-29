import * as z from 'zod/v4';
import { capabilityIdSchema } from './qualification-schema.mjs';
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const version = z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/);
export const honorRuleSchema = z.strictObject({
  sourceProfile:z.literal('facts-v2').optional(),
  id, version, title: z.string().trim().min(1).max(160), capabilityId: capabilityIdSchema, communityId: id,
  kind: z.enum(['open-contributor','ci-backed-contributor']),
  members: z.array(subject).min(2).max(128), relatedPartyGroups: z.array(z.array(subject).min(2).max(16)).max(16).default([]),
  notBefore: z.number().int().nonnegative(), notAfter: z.number().int().positive(), revoked: z.boolean().default(false),
  windowFrom: z.number().int().nonnegative(), windowUntil: z.number().int().positive(),
  minAcceptedCases: z.number().int().min(1).max(50), minProofs: z.number().int().min(0).max(50),
  repositories: z.array(z.strictObject({owner:z.string().regex(/^[A-Za-z0-9-]{1,100}$/),repository:z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)})).max(16),
  rankingEnabled: z.boolean().default(false), privacyReview: z.enum(['pending','approved']).default('pending'),
  minimumCohort: z.number().int().min(5).max(128).default(5), minimumCasesPerMember: z.number().int().min(3).max(50).default(3)
}).refine(v=>v.notAfter>v.notBefore && v.windowUntil>v.windowFrom && new Set(v.members).size===v.members.length
  && v.relatedPartyGroups.every(group=>new Set(group).size===group.length&&group.every(member=>v.members.includes(member)))
  && (v.kind==='ci-backed-contributor' ? v.minProofs>=1&&v.repositories.length>0 : v.minProofs===0)
  && (!v.rankingEnabled || v.privacyReview==='approved'));
const offset=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const honorQuerySchema = z.strictObject({ruleId:id,ruleVersion:version,subjectId:subject,
  limit:z.number().int().min(1).max(20).optional(),after:z.uuid().optional(),proofAfter:z.uuid().optional(),riskAfter:offset.optional(),
  sourceId:z.uuid().optional(),sourceAfter:offset.optional(),riskIndex:offset.optional(),riskReferenceAfter:offset.optional(),
  expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()});
export const honorRankingSchema = z.strictObject({ruleId:id,ruleVersion:version});
export const honorRuleHistorySchema=z.strictObject({ruleId:id.optional(),after:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),limit:z.number().int().min(1).max(20).default(8)});
