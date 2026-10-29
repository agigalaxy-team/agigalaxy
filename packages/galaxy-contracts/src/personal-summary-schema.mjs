import * as z from 'zod/v4';
export const sourceRefSchema=z.strictObject({messageId:z.uuid(),revision:z.number().int().positive()});
export const summaryContentSchema=z.strictObject({
 generator:z.strictObject({kind:z.enum(['user-model','manual']),label:z.string().max(120).optional()}),
 coverage:z.strictObject({fromSequence:z.string().regex(/^\d+$/),throughSequence:z.string().regex(/^\d+$/),complete:z.boolean()}),
 fragments:z.array(z.strictObject({id:z.uuid(),kind:z.enum(['derived','personal-note']),text:z.string().min(1).max(8000),
  sourceRefs:z.array(sourceRefSchema).max(100)}).refine(v=>v.kind!=='derived'||v.sourceRefs.length>0)).max(100),
 keyMessageRefs:z.array(sourceRefSchema).max(100)
}).refine(v=>BigInt(v.coverage.fromSequence)<=BigInt(v.coverage.throughSequence))
 .refine(v=>new TextEncoder().encode(JSON.stringify(v)).length<=65536)
 .refine(v=>new Set(v.fragments.map(f=>f.id)).size===v.fragments.length);
export const summaryPreferenceSchema=z.strictObject({expectedRevision:z.number().int().nonnegative(),endpoint:z.url(),enabled:z.boolean(),
 roomIds:z.array(z.uuid()).max(256).nullable().default(null),includeExisting:z.boolean().default(true)});
export const summaryPutSchema=z.strictObject({versionId:z.uuid(),summaryId:z.uuid(),roomId:z.uuid(),baseRevision:z.number().int().nonnegative(),
 preferenceRevision:z.number().int().nonnegative(),content:summaryContentSchema,resolveVersionIds:z.array(z.uuid()).max(100).default([])});
export const summaryPageSchema=z.strictObject({after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(10)});
export const summaryReceiptSchema=z.strictObject({summaryId:z.uuid(),versionId:z.uuid()});
