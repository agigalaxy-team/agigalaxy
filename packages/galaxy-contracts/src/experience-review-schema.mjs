import * as z from 'zod/v4';
import {capabilityIdSchema} from './qualification-schema.mjs';
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),note=z.string().trim().min(1).max(1600),id=z.uuid();
const common={id,operationId:id,expectedVersion:z.number().int().nonnegative(),reportedBy:subject,synthetic:z.boolean()};
export const experienceEventSchema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.enum(['external-work','challenge']),subjectId:subject,capabilityId:capabilityIdSchema,
    source:z.strictObject({system:z.string().trim().min(1).max(120),stableRecord:z.string().trim().min(1).max(1200),originalAt:z.iso.datetime(),originalAuthor:note,
      links:z.array(z.url()).max(16).default([]),contentVersion:z.string().trim().min(1).max(160)}),
    actualIntervention:note,resultReference:note,outcome:z.enum(['succeeded','partial','failed','inconclusive','conflicting']),scope:note,limitations:z.array(note).min(1).max(16),
    ownershipStatement:note,reason:note.optional(),expiresAt:z.iso.datetime().optional()}),
  z.strictObject({...common,kind:z.literal('review'),experienceRef:z.strictObject({id,version:z.number().int().positive()}),capabilityId:capabilityIdSchema,
    state:z.enum(['verified-in-scope','rejected','unavailable']),scope:note,observedAt:z.iso.datetime(),
    checked:z.strictObject({source:boolean(),attribution:boolean(),actualIntervention:boolean(),result:boolean(),acceptanceOrIndependentCheck:boolean()}),
    method:note,observations:note,limitations:z.array(note).min(1).max(16),sourceReferences:z.array(z.string().trim().min(1).max(1200)).min(1).max(16),
    relationship:z.literal('non-party'),reason:note.optional(),expiresAt:z.iso.datetime().optional()}),
  z.strictObject({...common,kind:z.literal('revoke'),objectType:z.enum(['experience','review']),reason:note}),
]);
function boolean(){return z.boolean();}
export const experienceReadSchema=z.strictObject({id,version:z.number().int().positive().optional()});
export const experienceReviewerSchema=z.strictObject({subjectId:subject,capabilityIds:z.array(capabilityIdSchema).min(1).max(32),
  kinds:z.array(z.enum(['external-work','challenge'])).min(1).max(2),scope:note,notBefore:z.number().int().nonnegative(),notAfter:z.number().int().positive(),
  authorityReference:note,synthetic:z.boolean().default(false)}).refine(v=>v.notAfter>v.notBefore);
