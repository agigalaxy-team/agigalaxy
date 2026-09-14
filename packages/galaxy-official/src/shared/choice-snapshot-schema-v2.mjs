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
