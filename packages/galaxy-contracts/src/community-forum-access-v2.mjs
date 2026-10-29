import * as z from 'zod/v4';
import {forumReadTopicSchema} from './community-forum-topics-v1.mjs';

const credentialRuleId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
const uuid=z.uuid(),text=max=>z.string().trim().min(1).max(max),version=z.number().int().nonnegative();
export const forumAudienceRuleSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('everyone')}),
 z.strictObject({kind:z.literal('accounts')}),
 z.strictObject({kind:z.literal('selected-accounts'),accountIds:z.array(uuid).min(1).max(64).refine(ids=>new Set(ids).size===ids.length)}),
 z.strictObject({kind:z.literal('external-credential'),issuerId:credentialRuleId,conditionId:credentialRuleId}),
 z.strictObject({kind:z.literal('honor'),ruleId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),ruleVersion:z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/)}),
]);
export const forumAudienceSchema=z.strictObject({read:forumAudienceRuleSchema,participate:forumAudienceRuleSchema});
// This is the historical unrestricted policy, not a new global user default.
export const legacyForumAudience=Object.freeze({read:Object.freeze({kind:'everyone'}),participate:Object.freeze({kind:'everyone'})});
export const forumSectionWriteSchema=z.strictObject({schemaVersion:z.literal(1),operationId:uuid,accountId:uuid.optional(),sectionId:uuid,
 expectedVersion:version,title:text(120),theme:text(400),description:z.string().trim().max(4000),audience:forumAudienceSchema,state:z.enum(['active','archived']).optional()});
export const forumSectionClassificationSchema=z.strictObject({schemaVersion:z.literal(1),operationId:uuid,sectionId:uuid,expectedVersion:version,category:forumReadTopicSchema});
export const forumSectionsQuerySchema=z.strictObject({after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20),managed:z.boolean().default(false)});
export const forumNotificationsQuerySchema=z.strictObject({after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20),unreadOnly:z.boolean().default(false)});
export const forumNotificationReadSchema=z.strictObject({replyId:uuid});
