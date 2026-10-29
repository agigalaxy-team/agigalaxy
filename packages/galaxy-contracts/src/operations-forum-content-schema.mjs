import {z} from 'zod';
import {forumReadTopicSchema} from './community-forum-topics-v1.mjs';

const id=z.uuid(),version=z.number().int().min(0).max(2147483646),kind=z.enum(['post','reply']),reason=z.string().trim().min(3).max(1600),
 sequence=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const contentAuditActions=Object.freeze(['community-content-query','community-content-read','community-content-visibility','community-content-curation','community-content-batch-preview','community-content-batch-visibility','community-tags-query','community-tag-create','community-tag-update']);
export const operationsContentQuerySchema=z.strictObject({query:z.string().trim().max(160).default(''),targetId:id.optional(),kind:kind.optional(),topic:forumReadTopicSchema.optional(),
 visibility:z.enum(['visible','hidden','unavailable']).optional(),pinned:z.boolean().optional(),featured:z.boolean().optional(),days:z.union([z.literal(7),z.literal(28),z.literal('all')]).default(7),
 after:z.string().regex(/^(post|reply):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).optional(),limit:z.number().int().min(1).max(100).default(25)});
export const operationsContentHistorySchema=z.strictObject({historyAfter:sequence.optional()});
const visibility={kind:z.enum(['hide','restore']),until:z.number().int().positive().optional()};
export const operationsContentVisibilitySchema=z.strictObject({operationId:id,expectedVersion:version,expectedRevision:version,...visibility,reason})
 .refine(value=>value.kind==='hide'?value.until!==undefined:value.until===undefined);
export const operationsContentCurationSchema=z.strictObject({operationId:id,expectedVersion:version,expectedRevision:version,topic:forumReadTopicSchema.nullable().optional(),
 pinned:z.boolean().optional(),featured:z.boolean().optional(),tagIds:z.array(id).max(8).refine(ids=>new Set(ids).size===ids.length).optional(),reason})
 .refine(value=>['topic','pinned','featured','tagIds'].some(key=>Object.hasOwn(value,key)));
const batchItem=z.strictObject({kind,id,expectedVersion:version,expectedRevision:version});
export const operationsContentBatchPreviewSchema=z.strictObject({...visibility,items:z.array(batchItem).min(1).max(25).refine(items=>new Set(items.map(item=>item.kind+':'+item.id)).size===items.length)})
 .refine(value=>value.kind==='hide'?value.until!==undefined:value.until===undefined);
export const operationsContentBatchSchema=operationsContentBatchPreviewSchema.safeExtend({operationId:id,reason});
const tagName=z.string().trim().min(1).max(40).refine(value=>!/[\p{Cc}]/u.test(value));
export const operationsTagCreateSchema=z.strictObject({operationId:id,name:tagName});
export const operationsTagUpdateSchema=z.strictObject({operationId:id,expectedVersion:version,name:tagName.optional(),enabled:z.boolean().optional()})
 .refine(value=>value.name!==undefined||value.enabled!==undefined);
