import {z} from 'zod';
import {resourceBudgetPolicySchema} from '../infrastructure/resource-budgets.mjs';
import {forumPolicySchema} from '../community-forum-policy-v1.mjs';
import {ServiceError} from './service-error.mjs';

// These are the existing consumer fields, not a generic remote configuration
// document. Credentials, connections and signed governance approvals stay out.
const communityLimits=z.strictObject({task:z.number().int().min(1).max(100000),comment:z.number().int().min(1).max(100000),invitation:z.number().int().min(1).max(100000)});
export const communityQuotaPolicySchema=z.strictObject({version:z.literal('community-quota/1'),new:communityLimits,normal:communityLimits,
  promotionDays:z.number().int().min(1).max(365),invitationCooldownDays:z.number().int().min(1).max(365)});
export const operationsPolicySchemas=Object.freeze({'resource-budget':resourceBudgetPolicySchema,'community-quota':communityQuotaPolicySchema,'forum-quota':forumPolicySchema});
export const operationsPolicyKeySchema=z.enum(['resource-budget','community-quota','forum-quota']);
export const operationsPageSchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(100).default(30)});
export const ruleSaveSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().min(1).max(2147483646),policy:z.unknown()});
const text=max=>z.string().max(max).refine(value=>![...value].some(char=>char.codePointAt(0)<32&&!['\n','\t','\r'].includes(char)));
const internalHref=z.string().max(2048).refine(value=>value.startsWith('/')&&!value.startsWith('//')&&!/[\s\\\p{Cc}]/u.test(value)&&!/^\/(?:api|v1|v2|admin)(?:\/|$)/.test(value));
const noticeContent=z.strictObject({purpose:z.enum(['maintenance','service-update','community-update']),title:text(160).min(1),body:text(8000).min(1),href:internalHref.nullable().default(null),
  audience:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('all-accounts')}),z.strictObject({kind:z.literal('accounts'),accountIds:z.array(z.uuid()).min(1).max(500).refine(ids=>new Set(ids).size===ids.length)})]),
  expiresAt:z.iso.datetime({offset:true})});
export const noticeCreateSchema=z.strictObject({operationId:z.uuid(),content:noticeContent});
export const noticeSaveSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().min(1).max(2147483646),content:noticeContent});
export const noticeActionSchema=z.strictObject({operationId:z.uuid(),expectedVersion:z.number().int().positive()});
export const accountNoticePageSchema=operationsPageSchema.extend({unreadOnly:z.boolean().default(false)});
export const retentionTargetSchema=z.enum(['private-conversation-archives','data-exports','information-watches']);
export const retentionRequestSchema=z.strictObject({operationId:z.uuid(),target:retentionTargetSchema});
export function operationsProductParse(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_operations_product_request');return parsed.data;}
export const operationsProductAuditActions=Object.freeze(['rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed']);
