import * as z from 'zod/v4';
import {searchV2ReferenceSchema} from './search-v2-schema.mjs';
export const choiceRefSchema=z.strictObject({type:z.enum(['history','case','capsule','task','opportunity','proof','worker','hub']),id:z.string().min(1).max(160),version:z.string().regex(/^[0-9a-f]{64}$/)});
const refKey=r=>`${r.type}:${r.id}:${r.version}`;
export const choiceContentSchema=z.strictObject({localVersion:z.number().int().positive(),localTaskRef:z.string().trim().min(1).max(300),
 visibleRationale:z.string().trim().min(1).max(1200),rationaleAuthor:z.enum(['user','user-agent']),
 candidateRefs:z.array(choiceRefSchema).min(1).max(64),selectedRefs:z.array(choiceRefSchema).max(64),
 resultRefs:z.array(z.strictObject({caseId:z.uuid(),id:z.uuid(),version:z.number().int().positive()})).max(16)
}).refine(x=>new Set(x.candidateRefs.map(refKey)).size===x.candidateRefs.length&&x.selectedRefs.every(r=>x.candidateRefs.some(c=>refKey(c)===refKey(r))))
 .refine(x=>new TextEncoder().encode(JSON.stringify(x)).length<=32768);
export const choicePreferenceSchema=z.strictObject({endpoint:z.url(),expectedRevision:z.number().int().nonnegative(),enabled:z.boolean(),snapshotIds:z.array(z.uuid()).max(256)})
 .refine(x=>new Set(x.snapshotIds).size===x.snapshotIds.length&&(!x.enabled||x.snapshotIds.length>0));
export const choicePutSchema=z.strictObject({snapshotId:z.uuid(),versionId:z.uuid(),baseRevision:z.number().int().nonnegative(),preferenceRevision:z.number().int().positive(),
 content:choiceContentSchema,witnesses:z.array(searchV2ReferenceSchema).min(1).max(64),resolveVersionIds:z.array(z.uuid()).max(64).default([])})
 .refine(x=>new Set(x.resolveVersionIds).size===x.resolveVersionIds.length);
export const choiceGetSchema=z.strictObject({snapshotId:z.uuid()});
export const choicePageSchema=z.strictObject({after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)});
export const choiceDeleteSchema=z.strictObject({snapshotId:z.uuid(),expectedRevision:z.number().int().nonnegative()});
// A transport preference revision and source witnesses are not the accepted
// business intent. Keep the same parsed defaults and hash input as original put.
export function choicePutIntent(input){const {preferenceRevision:_preferenceRevision,witnesses:_witnesses,...intent}=choicePutSchema.parse(input);return intent;}
export const choiceReceiptQuerySchema=z.strictObject({snapshotId:z.uuid(),versionId:z.uuid(),requestHash:z.string().regex(/^[0-9a-f]{64}$/)});
const receiptCommon={...choiceReceiptQuerySchema.shape,authority:z.literal('accepted-operation-only'),audience:z.literal('owner-only'),
 currentAccessGranted:z.literal(false),contentReturned:z.literal(false),sourceAccessChecked:z.literal(false)};
export const choiceReceiptResultSchema=z.discriminatedUnion('state',[
 z.strictObject({...receiptCommon,state:z.literal('acknowledged'),receipt:z.strictObject({snapshotId:z.uuid(),versionId:z.uuid(),
  requestHash:z.string().regex(/^[0-9a-f]{64}$/),baseRevision:z.number().int().nonnegative(),revision:z.number().int().nonnegative(),
  storedState:z.enum(['current','conflict','superseded','expired','deleted','invalidated']),acceptedAt:z.iso.datetime(),contentExpiresAt:z.iso.datetime(),
  contentRetentionDue:z.boolean()})}),
 z.strictObject({...receiptCommon,state:z.literal('absent'),absenceMeaning:z.literal('no-retained-owner-operation')}),
 z.strictObject({...receiptCommon,state:z.literal('conflict'),reason:z.literal('original-operation-mismatch')})
]).superRefine((x,c)=>{if(x.state==='acknowledged'&&['snapshotId','versionId','requestHash'].some(k=>x[k]!==x.receipt[k]))c.addIssue({code:'custom',message:'Original Choice receipt mismatch'});});
