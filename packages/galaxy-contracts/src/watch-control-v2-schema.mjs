import * as z from 'zod/v4';
const id=z.uuid(),revision=z.number().int().positive();
export const watchControlRegisterSchema=z.strictObject({operationId:id,watchId:id,roomId:id,agentGrantId:id,
 purpose:z.string().trim().min(1).max(500),expiresAt:z.number().int().positive(),taskId:id.optional()});
export const watchControlTakeoverSchema=z.strictObject({operationId:id,watchId:id,expectedRevision:revision,
 expectedGrantId:id,targetBindingId:id,newGrantId:id});
export const watchControlStopSchema=z.strictObject({operationId:id,watchId:id,expectedRevision:revision,expectedGrantId:id});
export const watchControlReadSchema=z.strictObject({watchId:id});
export const watchControlQuerySchema=z.strictObject({after:id.nullable().default(null),limit:z.number().int().min(1).max(50).default(20)});
export const watchControlReceiptSchema=z.strictObject({operationId:id,requestHash:z.string().regex(/^[0-9a-f]{64}$/)});
