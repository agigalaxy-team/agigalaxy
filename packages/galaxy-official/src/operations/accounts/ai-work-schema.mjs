import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';

export const aiWorkDomains=Object.freeze(['overview','governance','messaging','discovery','maintenance']);
export const aiWorkDomainLabels=Object.freeze({overview:'总控',governance:'治理',messaging:'消息',discovery:'数据与发现',maintenance:'运维'});
export const aiWorkActions=Object.freeze({read:'ai.accounts.read',profile:'ai.accounts.profile.write',state:'ai.accounts.state.write',roles:'ai.accounts.roles.write'});
export const aiWorkDomainSchema=z.enum(aiWorkDomains);
const id=z.uuid(),revision=z.number().int().nonnegative(),reason=z.string().trim().max(1000).default('');
export const aiWorkCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({operationId:id,kind:z.literal('profile-save'),expectedVersion:revision,name:z.string().trim().min(1).max(100),description:z.string().trim().max(1000),reason}),
 z.strictObject({operationId:id,kind:z.literal('state-save'),expectedVersion:revision,enabled:z.boolean(),reason}),
]);
export const aiWorkAssignmentSchema=z.strictObject({operationId:id,id:id.optional(),expectedVersion:revision,roleId:id,enabled:z.boolean()});
export const aiWorkOperationSchema=id;
export const aiWorkHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)});
export function aiWorkParse(schema,value){const result=schema.safeParse(value);if(!result.success)throw new ServiceError('invalid_operations_ai_work_request',400);return result.data;}

export {aiWorkQueryPermissions,aiWorkPreparation,aiWorkAutonomousPermissions,aiWorkCapabilities} from '../../shared/operations-ai-work-capabilities.mjs';
