import {z} from 'zod';

const text=max=>z.string().max(max).refine(value=>!Array.from(value).some(char=>char.codePointAt(0)<32&&!['\n','\t','\r'].includes(char)));
const internalHref=z.string().max(2048).refine(value=>value.startsWith('/')&&!value.startsWith('//')&&!/[\s\\\p{Cc}]/u.test(value)&&!/^\/(?:api|v1|v2|admin)(?:\/|$)/.test(value));
const noticeContent=z.strictObject({purpose:z.enum(['maintenance','service-update','community-update']),title:text(160).min(1),body:text(8000).min(1),href:internalHref.nullable().default(null),
  audience:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('all-accounts')}),z.strictObject({kind:z.literal('accounts'),accountIds:z.array(z.uuid()).min(1).max(500).refine(ids=>new Set(ids).size===ids.length)})]),
  expiresAt:z.iso.datetime({offset:true})});
export const noticeCreateSchema=z.strictObject({operationId:z.uuid(),content:noticeContent});
export const noticeSaveSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().min(1).max(2147483646),content:noticeContent});
export const noticeActionSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().positive()});
export const retentionTargetSchema=z.enum(['private-conversation-archives','data-exports','information-watches']);
export const retentionRequestSchema=z.strictObject({operationId:z.uuid(),target:retentionTargetSchema});
