import {z} from 'zod';

const uuid=z.uuid(),version=z.number().int().positive();
export const accountChatReportCategory=z.enum(['advertising','harassment','privacy','misrepresentation','other']);
export const accountChatRestrictionScope=z.enum(['sending-paused','invitations-paused']);
export const accountChatMaterialSelection=z.strictObject({
 messageId:uuid,revision:version,attachmentIds:z.array(uuid).max(16).refine(items=>new Set(items).size===items.length).default([])
});
const materials=z.array(accountChatMaterialSelection).max(20).refine(items=>new Set(items.map(item=>item.messageId)).size===items.length);
export const accountChatReportSchema=z.strictObject({
 operationId:uuid,roomId:uuid,roomVersion:version,category:accountChatReportCategory,
 summary:z.string().trim().min(1).max(1600),materials:materials.default([])
});
export const accountChatReportSourceSchema=z.strictObject({roomId:uuid,messageIds:z.array(uuid).max(20).refine(items=>new Set(items).size===items.length).default([])});
export const accountChatReportQuerySchema=z.strictObject({
 roomId:uuid.optional(),state:z.enum(['received','reviewing','resolved','appealed','withdrawn']).optional(),
 after:uuid.optional(),limit:z.number().int().min(1).max(50).default(20)
});
export const accountChatReportReadSchema=z.strictObject({reportId:uuid});
export const accountChatReportReceiptSchema=z.strictObject({operationId:uuid});
const eventBase={operationId:uuid,reportId:uuid,expectedVersion:version,summary:z.string().trim().min(1).max(1600)};
const restriction=z.strictObject({scopes:z.array(accountChatRestrictionScope).min(1).max(2).refine(items=>new Set(items).size===items.length),until:z.number().int().positive()});
export const accountChatReportEventSchema=z.discriminatedUnion('kind',[
 ...['supplement','appeal','withdraw-report','review','resume'].map(kind=>z.strictObject({...eventBase,kind:z.literal(kind),materials:materials.optional()})),
 z.strictObject({...eventBase,kind:z.literal('pause'),targetVersion:version,rule:z.string().trim().min(1).max(120),...restriction.shape}),
 z.strictObject({...eventBase,kind:z.literal('resolve'),targetVersion:version,rule:z.string().trim().min(1).max(120),verdict:z.enum(['upheld','dismissed']),restriction:restriction.nullable()})
]);
export const accountChatReportAttachmentSchema=z.strictObject({reportId:uuid,attachmentId:uuid});
