import {z} from 'zod';
import {resourceBudgetPolicySchema} from './policies/resource-budget.mjs';
import {forumPolicySchema} from './policies/forum-quota.mjs';
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
export {noticeCreateSchema,noticeSaveSchema,noticeActionSchema,retentionTargetSchema,retentionRequestSchema} from './operations-notice-retention-schema.mjs';
export const accountNoticePageSchema=operationsPageSchema.extend({unreadOnly:z.boolean().default(false)});
export function operationsProductParse(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_operations_product_request');return parsed.data;}
export const operationsProductAuditActions=Object.freeze(['rule-save','notice-create','notice-save','notice-publish','notice-withdraw','notice-delivery','retention-request','retention-complete','retention-failed']);
