import {z} from 'zod';
import {p13Workflow} from './p13-strategies-schema.mjs';

// The fixed workflow names are metadata; free-form model/tool content is not.
const stepName=z.enum(['核对策略、授权与源版本','复杂条件才使用AI','复杂条件判断','普通事项缺输入时补充','补充本事项处理选择','需要人工时暂停','人工确认本事项','执行原受控命令并记录结果']);
const nativeId=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),pauseId=z.string().regex(/^[A-Za-z0-9_-]{1,128}:[0-9]{1,6}$/);
export const p13NativeRunMetadataSchema=z.object({runId:nativeId.nullable(),status:z.enum(['NOT_RECORDED','PENDING','RUNNING','PAUSED','COMPLETED','CANCELLED','ERROR']),awaitingHuman:z.boolean(),pauseKind:z.enum(['input','confirmation']).nullable().optional(),pauseId:pauseId.nullable().optional(),
 workflowId:z.literal(p13Workflow.id),workflowVersion:z.literal(p13Workflow.version),steps:z.array(z.object({name:stepName,type:z.string().max(30).nullable().optional(),success:z.boolean()})).max(50).optional(),currentStep:stepName.nullable().optional()});
