import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

export const messagingChannels=Object.freeze(['announcement','inapp','email']);
export const messagingSenderKeys=Object.freeze(['account','notice','community','updates','team']);
const text=max=>z.string().trim().min(1).max(max).refine(value=>![...value].some(char=>char.codePointAt(0)<32&&!['\n','\t','\r'].includes(char)));
const unique=values=>new Set(values).size===values.length;
const ids=z.array(z.uuid()).min(1).max(500).refine(unique);
const internalHref=z.string().max(2048).refine(value=>value.startsWith('/')&&!value.startsWith('//')&&!/[\s\\\p{Cc}]/u.test(value)&&!/^\/(?:api|v1|v2|admin)(?:\/|$)/.test(value));
export const messagingAudienceSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('all-accounts')}),
 z.strictObject({kind:z.literal('accounts'),accountIds:ids}),
 z.strictObject({kind:z.literal('attributes'),subjectTypes:z.array(z.enum(['person','agent','organization'])).min(1).max(3).refine(unique)}),
]);
export const messagingConfigSchema=z.strictObject({
 channels:z.array(z.enum(messagingChannels)).min(1).max(3).refine(unique),
 content:z.strictObject({purpose:z.enum(['maintenance','service-update','community-update']),title:text(160),body:text(8000),href:internalHref.nullable().default(null),expiresAt:z.iso.datetime({offset:true})}),
 audience:messagingAudienceSchema,
 senderKey:z.enum(messagingSenderKeys).default('notice'),
 // A human identifies the ordinary, verified purpose before a policy may
 // publish it autonomously. Existing drafts stay human-reviewed by default.
 automation:z.strictObject({kind:z.enum(['human-required','ordinary']),factsConfirmed:z.boolean()}).refine(value=>value.kind!=='ordinary'||value.factsConfirmed).optional(),
 schedule:z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('immediate')}),
  z.strictObject({kind:z.literal('once'),at:z.iso.datetime({offset:true})}),
  z.strictObject({kind:z.literal('recurring'),cron:text(160),timezone:z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}})}),
 ]),
});
const version=z.number().int().min(1).max(2147483646);
export const messagingCreateSchema=z.strictObject({operationId:z.uuid(),config:messagingConfigSchema});
export const messagingSaveSchema=z.strictObject({operationId:z.uuid(),expectedVersion:version,expectedRevision:version,config:messagingConfigSchema});
export const messagingActionSchema=z.strictObject({operationId:z.uuid(),expectedVersion:version,expectedRevision:version});
export const messagingRetrySchema=z.strictObject({operationId:z.uuid(),expectedRevision:version});
const after=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const messagingPageSchema=z.strictObject({after:after.optional(),limit:z.number().int().min(1).max(100).default(30)});
export const messagingPlansQuerySchema=messagingPageSchema.extend({state:z.enum(['draft','active','paused','stopped']).optional()});
export const messagingRunsQuerySchema=messagingPageSchema.extend({planId:z.uuid().optional()});
export const messagingRecipientsQuerySchema=messagingPageSchema.extend({channel:z.enum(['inapp','email']).optional(),state:z.enum(['pending','submitting','submitted','delivered','skipped','failed','unknown','blocked']).optional()});
export const messagingJobSchema=z.strictObject({planId:z.uuid(),planVersion:version});
export const messagingDeliveryJobSchema=z.strictObject({runId:z.uuid()});
export function messagingParse(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_operations_messaging_request');return parsed.data;}
