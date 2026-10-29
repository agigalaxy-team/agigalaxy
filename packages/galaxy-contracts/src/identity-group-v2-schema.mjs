import * as z from 'zod/v4';
import {trustSubject,trustCanonical} from './trust-package-crypto.mjs';
export const identityGroupSignatureType='galaxy-identity-group-v2+jws';
const uuid=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),second=z.number().int().nonnegative();
const subjects=z.array(trustSubject).max(16).refine(x=>new Set(x).size===x.length);
export const identityGroupSourceSchema=z.strictObject({kind:z.enum(['case-event','configuration']),id:uuid,version:z.number().int().positive(),
 caseId:uuid.optional(),taskId:uuid.optional(),sourceHash:hash,originalSubjectId:trustSubject});
export const identityGroupSourceSelectionSchema=identityGroupSourceSchema.omit({sourceHash:true,originalSubjectId:true});
const correction=z.strictObject({source:identityGroupSourceSchema,displaySubjectId:trustSubject,reason:z.string().min(1).max(800)});
const common={schemaVersion:z.literal(2),operationId:uuid,groupId:uuid,endpoint:z.url().refine(x=>new URL(x).origin===x&&x.startsWith('https://')),
 expectedVersion:z.number().int().nonnegative(),previousOperationId:uuid.nullable(),issuedAt:second,expiresAt:second};
export const identityGroupIntentSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.enum(['create','revise']),memberIds:subjects.refine(x=>x.length>=2&&x.length<=8),canonicalDisplayId:trustSubject,
  visibility:z.enum(['Private','Public']),viewers:subjects,sourceRefs:z.array(identityGroupSourceSchema).max(100),attributionCorrections:z.array(correction).max(100),
  purpose:z.literal('canonical-display-only'),capabilityMerged:z.literal(false),accessGranted:z.literal(false)}),
 z.strictObject({...common,kind:z.literal('revoke'),reason:z.string().min(1).max(800)}),
]).refine(p=>p.expiresAt>p.issuedAt&&p.expiresAt<=p.issuedAt+86400)
 .refine(p=>p.kind==='revoke'||p.memberIds.includes(p.canonicalDisplayId)&&p.sourceRefs.every(r=>p.memberIds.includes(r.originalSubjectId))&&
  p.attributionCorrections.every(c=>p.memberIds.includes(c.displaySubjectId)&&p.sourceRefs.some(r=>trustCanonical(r)===trustCanonical(c.source))))
 .refine(p=>p.kind==='revoke'||new Set(p.sourceRefs.map(r=>r.kind+':'+r.id+':'+r.version)).size===p.sourceRefs.length)
 .refine(p=>p.kind==='revoke'||new Set(p.attributionCorrections.map(c=>c.source.kind+':'+c.source.id+':'+c.source.version)).size===p.attributionCorrections.length);
export const identityGroupProofSchema=z.strictObject({schemaVersion:z.literal(2),id:uuid,operationId:uuid,groupId:uuid,payloadHash:hash,
 endpoint:z.string(),subjectId:trustSubject,keyId:hash,epoch:z.number().int().nonnegative(),decision:z.enum(['approve','decline','cancel']),issuedAt:second,expiresAt:second});
export const identityGroupSubmitSchema=z.strictObject({payloadJson:z.string().min(1).max(100000),proofJson:z.string().min(1).max(2000),signature:z.string().min(1).max(4000)});
export const identityGroupQuerySchema=z.strictObject({subjectId:trustSubject.optional(),after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20),
 includeProposals:z.boolean().default(false),proposalAfter:uuid.optional(),proposalLimit:z.number().int().min(1).max(50).default(20),proposalDirection:z.enum(['all','incoming','outgoing']).default('all')});
export const identityGroupReceiptSchema=z.strictObject({operationId:uuid,payloadHash:hash});
