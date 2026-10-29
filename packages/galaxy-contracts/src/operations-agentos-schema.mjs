import {z} from 'zod';
import {operationsPermissionCodes} from './operations-permission-catalog.mjs';
import {operationsToolCallIdSchema} from './operations-tool-call-id.mjs';

export const agentOsDomains=['overview','governance','messaging','discovery','maintenance'];
export const agentOsOperationIdSchema=z.uuid();
const ids=z.array(z.uuid()).max(100).refine(v=>new Set(v).size===v.length);
const preparedInput=z.strictObject({expectedVersion:z.number().int().nonnegative(),expectedRevision:z.number().int().nonnegative(),
 kind:z.enum(['hide','restore']),until:z.number().int().positive().optional(),reason:z.string().trim().min(3).max(1600)})
 .refine(v=>v.kind==='hide'?v.until!==undefined:v.until===undefined);
export const agentOsCreateSchema=z.strictObject({operationId:z.uuid(),grantId:z.uuid(),expectedGrantVersion:z.number().int().positive(),
 domain:z.enum(agentOsDomains),actions:z.array(z.enum(operationsPermissionCodes)).max(100).refine(v=>new Set(v).size===v.length),resourceIds:ids,
 preparedCommand:z.strictObject({tool:z.literal('content-visibility'),targetKind:z.enum(['post','reply']),targetId:z.uuid(),input:preparedInput}).nullable().default(null)});
export const agentOsStateSchema=z.strictObject({operationId:z.uuid(),expectedRevision:z.number().int().positive(),kind:z.enum(['pause','resume','stop'])});
export const agentOsNativeAuthoritySchema=z.strictObject({executionId:z.uuid(),operation:z.enum(['read','run']),resourceType:z.enum(['agents','workflows']).nullable().optional(),resourceId:z.string().min(1).max(100).nullable().optional()});
export const agentOsToolSchema=z.strictObject({executionId:z.uuid(),tool:z.enum(['read-selected-content','search-selected-public-content','execute-prepared-command']),
 arguments:z.record(z.string(),z.unknown()),runId:z.string().min(1).max(128),callId:operationsToolCallIdSchema});
export const agentOsRunSchema=z.strictObject({operationId:z.uuid(),message:z.string().trim().min(1).max(12000)});
export const agentOsContinueSchema=z.strictObject({operationId:z.uuid(),runId:z.string().min(1).max(128),confirmed:z.boolean()});
