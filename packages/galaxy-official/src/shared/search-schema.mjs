import * as z from 'zod/v4';
import { historyQuerySchema } from './history-schema.mjs';
import { capsuleQuerySchema } from './capsule-schema.mjs';
import { builderQuerySchema } from './builders-schema.mjs';

export const proofSearchSchema=z.strictObject({query:z.string().trim().max(200).default(''),
  subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),
  conclusion:z.enum(['success','failure','neutral','cancelled','skipped','timed_out','action_required','stale','startup_failure']).optional(),
  after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)
}).refine(value=>new Set(value.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean)).size<=8);
const typedHistoryQuerySchema=historyQuerySchema.safeExtend({limit:z.number().int().min(1).max(20).default(8)});
const builderSearchSchema=builderQuerySchema.omit({type:true}).refine(value=>new Set(value.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean)).size<=8);
export const searchSourceTypes=Object.freeze(['case','history','proof','capsule','worker','hub']);
export const searchQuerySchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('case'),query:typedHistoryQuerySchema}),
  z.strictObject({type:z.literal('history'),query:typedHistoryQuerySchema}),
  z.strictObject({type:z.literal('proof'),query:proofSearchSchema}),
  z.strictObject({type:z.literal('capsule'),query:capsuleQuerySchema}),
  z.strictObject({type:z.literal('worker'),query:builderSearchSchema}),
  z.strictObject({type:z.literal('hub'),query:builderSearchSchema})
]);
export const searchScope=type=>type==='proof'?'proof':type==='capsule'?'capsules':['worker','hub'].includes(type)?'builders':'history';
