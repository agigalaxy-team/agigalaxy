import * as z from 'zod/v4';
import {capabilityIdSchema} from './qualification-schema.mjs';
export const qualificationEvidenceV2Schema=z.strictObject({
  participationIds:z.array(z.uuid()).max(32).default([]),externalReviewRefs:z.array(z.strictObject({id:z.uuid(),version:z.number().int().positive()})).max(32).default([]),
  capsuleUseIds:z.array(z.uuid()).max(32).default([]),proofIds:z.array(z.uuid()).max(16).default([]),assistanceIds:z.array(z.uuid()).max(16).default([]),
  calculationGrantId:z.uuid().optional(),
});
export const qualificationQueryV2Schema=z.strictObject({taskId:z.uuid(),subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),
  policyId:z.string().min(1).max(80).optional(),policyVersion:z.string().min(1).max(32).optional(),capabilityId:capabilityIdSchema.optional(),
  evidence:qualificationEvidenceV2Schema.default({participationIds:[],externalReviewRefs:[],capsuleUseIds:[],proofIds:[],assistanceIds:[]}),
  includeSimulation:z.boolean().default(false)});
export const qualificationCandidatesV2Schema=z.strictObject({taskId:z.uuid(),kind:z.enum(['participation','external-review','calculation','capsule-use','proof','legacy-assistance']),
  after:z.uuid().optional(),limit:z.number().int().min(1).max(30).default(12)});
