import {z} from 'zod';

export const operationsChatMessageTargetSchema=z.strictObject({reportId:z.uuid(),messageId:z.uuid()});
export const operationsChatMessageVisibilitySchema=z.strictObject({
 operationId:z.uuid(),expectedVersion:z.number().int().positive(),
 expectedRevision:z.number().int().min(0),messageRevision:z.number().int().positive(),
 action:z.enum(['hide','restore','keep']),summary:z.string().trim().min(1).max(1600)
});
