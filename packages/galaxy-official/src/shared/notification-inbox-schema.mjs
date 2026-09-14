import * as z from 'zod/v4';
export const inboxIdSchema=z.string().regex(/^(target-governance|information-change|qualification-request|assistance|context|context-accept|capsule|incident|room-message|room-invite|task-v2|task-comment|comment-governance):[0-9a-f-]{36}$/).refine(v=>z.uuid().safeParse(v.split(':')[1]).success);
const ids=z.array(z.uuid()).max(256),subjects=z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(256);
export const inboxOptionsSchema=z.strictObject({rooms:z.boolean().default(true),tasks:z.boolean().default(true),mutedRoomIds:ids.default([]),blockedSubjectIds:subjects.default([]),
 roomBlocks:z.array(z.strictObject({roomId:z.uuid(),subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/)})).max(256).default([])});
export const inboxQuerySchema=z.strictObject({after:inboxIdSchema.optional(),limit:z.number().int().min(1).max(20).default(10),unreadOnly:z.boolean().default(false)});
export const inboxClaimSchema=z.strictObject({id:inboxIdSchema,deliveryClientId:z.uuid(),claimId:z.uuid()});
